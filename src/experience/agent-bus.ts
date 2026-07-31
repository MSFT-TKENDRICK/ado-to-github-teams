// Shared write-ahead persona bus — DOMAIN module.
//
// Purpose: prevent outcome-bias contamination when a persona (operator or contributor) records
// what it expected an interaction to do vs. what actually happened. Every observation must go
// through a two-phase intent -> outcome ordering that is structurally enforced by the API
// surface, not merely by convention.
//
// This module is pure domain: schemas, tagged errors, the `AgentBusTag`/`RunIdentityTag` service
// interfaces, the `runWithIntent` orchestration operating over an abstract sink, and pure
// validation / redaction / matrix helpers. It has no direct dependency on `node:fs`,
// `node:crypto`, or any other runtime capability. The concrete Node adapter — filesystem sink,
// resume file decoding, and `RunIdentityLive` (the ONLY place that calls `crypto.randomUUID`) —
// lives in `./agent-bus-live.ts`. This mirrors the existing domain/adapter split used for
// `CheckpointStoreTag` (`src/effect/services.ts` + `src/checkpoints/manager.ts` +
// `src/effect/layers.ts`'s `makeCheckpointLayer`).
//
// Two phases:
//   1. `recordIntent` — the persona describes what interface it perceives, the action it intends,
//      and the result it expects. This MUST be appended and confirmed before any downstream action
//      runs. On success the caller receives a branded, non-forgeable `IntentAck` token.
//   2. `recordOutcome(ack, payload)` — the persona reports the actual result, a delta description,
//      and a bounded desirability judgment. The persisted `correlationId` is taken from the ack —
//      the caller does not supply it — so a caller cannot claim an outcome for a correlationId it
//      never received a real ack for. Each correlationId may only be resolved once. The payload
//      schema is strict: an excess `correlationId` (or any other unknown) field is rejected as a
//      typed decode failure rather than silently disregarded.
//
// `runWithIntent` is the critical anti-outcome-bias primitive. Because the action closure receives
// the `IntentAck` returned by `recordIntent`, and `IntentAck` is only produced when the intent has
// been successfully appended, it is a type error to run the action before the intent write
// succeeds. There is no way to fabricate an `IntentAck`, no method to mutate a recorded intent,
// and no method to delete an intent — the persona cannot fake a write-ahead after seeing the
// outcome, and cannot silently "update" its prediction to match reality.
//
// Terminal-outcome contract: `runWithIntent` ALWAYS ATTEMPTS to append a terminal outcome for
// every intent it records — success, typed failure, unchecked defect, or interruption. If that
// append itself fails, the failure is surfaced as a typed `TerminalOutcomeAppendFailure` (never
// swallowed). This is an "attempt is guaranteed; success is not" contract — the exact wording of
// this claim is pinned to a documentation drift test so it cannot silently regress into an
// absolute-guarantee falsehood. The `toOutcome` callback is authored by the CALLER for ALL four
// exit shapes: the bus does not synthesize any generic outcome payload on the caller's behalf,
// because only the caller has the persona-specific domain knowledge (sensitivities, predictions,
// levers) needed to describe what actually happened vs what they expected.
//
// See `DESIRABILITY_SCALE_DESCRIPTION` for the single, authoritative wording of the `degree`
// scale. AGENTS.md quotes that constant verbatim; a documentation contract test asserts they can
// never silently drift apart.

import {Cause, Clock, Context, Data, Effect, Either, Exit, Layer, Ref, Schema} from 'effect'
import {DEVELOPER_PERSONA_IDS, OPERATOR_PERSONA_IDS, PERSONA_DEFINITIONS} from './personas.js'

// Protocol version. Bump when the on-disk JSONL shape or a schema field changes in a way that a
// resumer cannot decode. The bus itself rejects any recorded event whose `protocolVersion` does
// not match the currently supported literal.
export const AGENT_BUS_PROTOCOL_VERSION = '1' as const

/**
 * Authoritative wording of the `degree` desirability scale. This is the SINGLE source of truth
 * for how `degree` is interpreted; AGENTS.md quotes it verbatim and a documentation contract test
 * asserts the two do not drift. `degree` is a pure desirability judgment. The separate `delta`
 * field is where expected-vs-actual accuracy/comparison lives — the two must not be conflated.
 */
export const DESIRABILITY_SCALE_DESCRIPTION =
  'degree scale: 0.0 = fully undesirable, 0.5 = neutral or mixed, 1.0 = fully desirable. ' +
  'degree is a pure desirability judgment. The delta field describes expected-vs-actual ' +
  'comparison and is conceptually independent from degree.'

/**
 * Authoritative wording of the terminal-outcome guarantee. This is a strict "attempt is
 * guaranteed; success is not" contract — never an absolute-guarantee claim that a record is
 * never left unresolved. AGENTS.md quotes it verbatim; a documentation drift test pins it.
 *
 * The guarantee explicitly carves out one case: the CALLER's outcome-authoring callback
 * (`toOutcome`) itself throwing. The attempt guarantee covers the action's own exit; if the
 * caller's `toOutcome` throws, that specific iteration surfaces a typed `OutcomeAuthoringFailure`
 * (bounded, value-free) and no outcome record is written for it. Every externally-surfaced
 * bus failure is bounded and value-free — tag/class name, field name or path, line number, and
 * reason code only; no raw parsed value, no raw malformed JSON text, no literal excerpt of a
 * persona payload is ever embedded in a failure.
 */
export const TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION =
  'A terminal outcome append is ALWAYS ATTEMPTED for every started action — success, typed ' +
  'failure, unchecked defect, or interruption. If the terminal append itself fails, the failure ' +
  'is surfaced as a typed TerminalOutcomeAppendFailure (never swallowed). This is an attempt ' +
  'guarantee, not an absolute guarantee that a record is never left unresolved. The attempt ' +
  'guarantee covers the action\u2019s own exit; if the caller\u2019s outcome-authoring callback ' +
  'itself throws, that specific iteration surfaces a typed OutcomeAuthoringFailure and no ' +
  'outcome record is written for it. Every externally-surfaced bus failure is bounded and ' +
  'value-free: only tag/class name, field name or path, line number, and reason code are ' +
  'exposed; no raw parsed value, no raw malformed JSON text, and no literal excerpt of a persona ' +
  'payload is ever embedded in a failure.'

export const AgentBusDomainSchema = Schema.Literal('operator', 'developer')
export type AgentBusDomain = Schema.Schema.Type<typeof AgentBusDomainSchema>

export const AgentBusSkillSchema = Schema.Literal('optimize-ux', 'optimize-dx')
export type AgentBusSkill = Schema.Schema.Type<typeof AgentBusSkillSchema>

export const DesirabilitySchema = Schema.Literal('desirable', 'neutral', 'undesirable')
export type Desirability = Schema.Schema.Type<typeof DesirabilitySchema>

// Every persisted event carries `runId` in-band so its owning run is recoverable from the
// event's own content, not only from the file path it happens to live in. This matters for
// future log aggregation / replay tooling that may not preserve directory structure.
export const IntentEventSchema = Schema.Struct({
  runId: Schema.String.pipe(Schema.minLength(1)),
  correlationId: Schema.String.pipe(Schema.minLength(1)),
  personaId: Schema.String.pipe(Schema.minLength(1)),
  domain: AgentBusDomainSchema,
  skill: AgentBusSkillSchema,
  iteration: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  perceivedInterface: Schema.String,
  intendedAction: Schema.String,
  expectedResult: Schema.String,
  protocolVersion: Schema.Literal(AGENT_BUS_PROTOCOL_VERSION),
  recordedAt: Schema.String,
})
export type IntentEvent = Schema.Schema.Type<typeof IntentEventSchema>

/**
 * `degree` is a pure desirability judgment bounded in `[0, 1]`. See
 * `DESIRABILITY_SCALE_DESCRIPTION` for the authoritative anchors. `delta` — a separate field —
 * describes expected-vs-actual comparison. Do not conflate the two.
 */
export const OutcomeEventSchema = Schema.Struct({
  runId: Schema.String.pipe(Schema.minLength(1)),
  correlationId: Schema.String.pipe(Schema.minLength(1)),
  actualResult: Schema.String,
  delta: Schema.String,
  desirability: DesirabilitySchema,
  degree: Schema.Number.pipe(Schema.between(0, 1)),
  observedFriction: Schema.optional(Schema.String),
  protocolVersion: Schema.Literal(AGENT_BUS_PROTOCOL_VERSION),
  recordedAt: Schema.String,
})
export type OutcomeEvent = Schema.Schema.Type<typeof OutcomeEventSchema>

/**
 * Wire event: an intent line as it appears on-disk. The `kind` discriminator lets a resumer read
 * one JSONL file and cheaply route each line to the right decoder.
 */
export const IntentEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal('intent'),
  runId: Schema.String.pipe(Schema.minLength(1)),
  correlationId: Schema.String.pipe(Schema.minLength(1)),
  personaId: Schema.String.pipe(Schema.minLength(1)),
  domain: AgentBusDomainSchema,
  skill: AgentBusSkillSchema,
  iteration: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  perceivedInterface: Schema.String,
  intendedAction: Schema.String,
  expectedResult: Schema.String,
  protocolVersion: Schema.Literal(AGENT_BUS_PROTOCOL_VERSION),
  recordedAt: Schema.String,
})

export const OutcomeEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal('outcome'),
  runId: Schema.String.pipe(Schema.minLength(1)),
  correlationId: Schema.String.pipe(Schema.minLength(1)),
  actualResult: Schema.String,
  delta: Schema.String,
  desirability: DesirabilitySchema,
  degree: Schema.Number.pipe(Schema.between(0, 1)),
  observedFriction: Schema.optional(Schema.String),
  protocolVersion: Schema.Literal(AGENT_BUS_PROTOCOL_VERSION),
  recordedAt: Schema.String,
})

export const WireEnvelopeSchema = Schema.Union(IntentEnvelopeSchema, OutcomeEnvelopeSchema)

// Input shapes exclude the timestamp — the bus injects `recordedAt` so a caller cannot lie about
// when a prediction was made. `protocolVersion` is OPTIONAL on input: when omitted the bus
// injects the current version; when supplied it must match the current version or the bus
// rejects the write with `ProtocolVersionMismatchFailure`.
export interface IntentInput {
  readonly correlationId: string
  readonly personaId: string
  readonly domain: AgentBusDomain
  readonly skill: AgentBusSkill
  readonly iteration: number
  readonly perceivedInterface: string
  readonly intendedAction: string
  readonly expectedResult: string
  readonly protocolVersion?: string
}

/**
 * Outcome payload as accepted by `recordOutcome(ack, payload)`. The persisted `correlationId`
 * is taken from the ack — the caller does NOT supply it. Correlation identity for an outcome
 * comes ONLY from the `IntentAck` parameter. Excess properties (including a caller-supplied
 * `correlationId`) are rejected at decode time via `Schema.Struct(...)` with strict decoding
 * — a caller who mistakenly includes an alias field gets a typed rejection, not silent
 * disregard.
 */
export const OutcomeInputPayloadSchema = Schema.Struct({
  actualResult: Schema.String,
  delta: Schema.String,
  desirability: DesirabilitySchema,
  degree: Schema.Number.pipe(Schema.between(0, 1)),
  observedFriction: Schema.optional(Schema.String),
  protocolVersion: Schema.optional(Schema.String),
})
export type OutcomeInputPayload = Schema.Schema.Type<typeof OutcomeInputPayloadSchema>

// Module-scoped unique symbol used as a brand on IntentAck. Because this symbol is not exported,
// an external caller cannot reference it, and therefore cannot construct an object literal that
// satisfies the IntentAck interface — only a successful `recordIntent` call (internal to this
// module) can produce one. `as IntentAck` casts still work, but that is a deliberate compile-time
// escape hatch, not a public API surface.
const IntentAckBrand: unique symbol = Symbol('AgentBus/IntentAckBrand')

export interface IntentAck {
  readonly correlationId: string
  readonly recordedAt: string
  readonly runId: string
  readonly [IntentAckBrand]: true
}

/**
 * Snapshot of the intent record for use inside `runWithIntent`'s `toOutcome` callback. Kept
 * intentionally narrow: exposes only immutable identity fields the caller needs to author an
 * outcome payload — nothing the caller could use to mutate the recorded intent.
 */
export interface IntentSnapshot {
  readonly correlationId: string
  readonly runId: string
  readonly personaId: string
  readonly domain: AgentBusDomain
  readonly skill: AgentBusSkill
  readonly iteration: number
  readonly perceivedInterface: string
  readonly intendedAction: string
  readonly expectedResult: string
  readonly recordedAt: string
}

function toIntentSnapshot(event: IntentEvent): IntentSnapshot {
  return {
    correlationId: event.correlationId,
    runId: event.runId,
    personaId: event.personaId,
    domain: event.domain,
    skill: event.skill,
    iteration: event.iteration,
    perceivedInterface: event.perceivedInterface,
    intendedAction: event.intendedAction,
    expectedResult: event.expectedResult,
    recordedAt: event.recordedAt,
  }
}

function makeIntentAck(correlationId: string, recordedAt: string, runId: string): IntentAck {
  return {correlationId, recordedAt, runId, [IntentAckBrand]: true}
}

export class IntentDecodeFailure extends Data.TaggedError('IntentDecodeFailure')<{
  readonly correlationId: string
}> {}

export class OutcomeDecodeFailure extends Data.TaggedError('OutcomeDecodeFailure')<{
  readonly correlationId: string
}> {}

export class OutcomePayloadDecodeFailure extends Data.TaggedError('OutcomePayloadDecodeFailure')<{
  readonly correlationId: string
}> {}

export class IntentMissingFailure extends Data.TaggedError('IntentMissingFailure')<{
  readonly correlationId: string
}> {}

export class DuplicateIntentFailure extends Data.TaggedError('DuplicateIntentFailure')<{
  readonly correlationId: string
}> {}

export class DuplicateOutcomeFailure extends Data.TaggedError('DuplicateOutcomeFailure')<{
  readonly correlationId: string
}> {}

export class ProtocolVersionMismatchFailure extends Data.TaggedError(
  'ProtocolVersionMismatchFailure',
)<{
  readonly expected: string
  readonly actual: string
}> {}

/**
 * A sink append failed. `errorCode` is a bounded, non-payload-derived classifier (e.g. a Node
 * error code, or `'AGENT_BUS_WRITE_FAILURE'` for injected/test failures). No raw sink error
 * text is embedded so a caller who logs the failure cannot inadvertently surface a raw path,
 * payload fragment, or upstream exception message.
 */
export class AgentBusWriteFailure extends Data.TaggedError('AgentBusWriteFailure')<{
  readonly errorCode: string
}> {}

/**
 * An `IntentAck` does not belong to this bus instance / run. Raised when either:
 *   - `ack.runId` does not match the bus's current `runId` (a caller passed an ack from a
 *     different bus/run), OR
 *   - the recorded intent for `ack.correlationId` has a different `recordedAt` than the ack
 *     (a same-correlationId ack minted by a different intent record than the one currently
 *     stored — a stale ack pointed at a re-created intent slot).
 *
 * The failure NEVER embeds the raw runId or recordedAt values — only the correlationId (which
 * is caller-controlled structural metadata) and a bounded reason code.
 */
export class IntentAckMismatchFailure extends Data.TaggedError('IntentAckMismatchFailure')<{
  readonly correlationId: string
  readonly reason: 'run-id-mismatch' | 'recorded-at-mismatch'
}> {}

/**
 * The caller supplied both a fresh `runId` and a `resumeFromRunId` that disagree with each
 * other. Raised BEFORE any filesystem access so a contradictory configuration cannot silently
 * partially execute. The `reason` describes what the check saw without embedding either
 * caller-supplied value literally.
 */
export class ConflictingRunOptionsFailure extends Data.TaggedError('ConflictingRunOptionsFailure')<{
  readonly reason: 'runId-does-not-match-resumeFromRunId'
}> {}

/**
 * The caller's `toOutcome` callback threw an unchecked exception. Surfaced instead of a silent
 * defect so the "attempt guarantee" wording remains honest: the attempt guarantee covers the
 * action's own exit, and if `toOutcome` throws that specific iteration surfaces this typed
 * failure and no outcome record is written for it. The original action exit classification is
 * attached for diagnostics; the thrown error's raw text is NEVER embedded (only the exit tag).
 */
export class OutcomeAuthoringFailure extends Data.TaggedError('OutcomeAuthoringFailure')<{
  readonly correlationId: string
  readonly originalActionExitTag: 'Success' | 'TypedFailure' | 'Defect' | 'Interrupt'
}> {}

/**
 * Persona identity, domain, and skill do not form a valid triple. Raised BEFORE any file path is
 * constructed or any write is attempted, so a malformed identity can never touch the filesystem.
 * The `reason` describes which invariant failed without embedding raw payload content.
 */
export class PersonaDomainSkillMismatchFailure extends Data.TaggedError(
  'PersonaDomainSkillMismatchFailure',
)<{
  readonly personaId: string
  readonly domain: AgentBusDomain
  readonly skill: AgentBusSkill
  readonly reason:
    | 'unknown-persona'
    | 'operator-skill-mismatch'
    | 'developer-skill-mismatch'
    | 'domain-persona-mismatch'
}> {}

/**
 * An identifier that will be embedded in a filesystem path fails the defensive charset check
 * (contains `/`, `\`, `..`, null bytes, is empty, or is unreasonably long). Raised before any
 * `stat`/`mkdir`/`path.join` call. This is defence-in-depth on top of the enumerated
 * persona/domain/skill matrix and covers `personaId`, `runId`, and `resumeFromRunId`.
 */
export class PathUnsafeIdentifierFailure extends Data.TaggedError('PathUnsafeIdentifierFailure')<{
  readonly field: 'personaId' | 'runId' | 'resumeFromRunId'
  readonly reason:
    'contains-path-separator' | 'contains-dotdot' | 'contains-null-byte' | 'empty' | 'too-long'
}> {}

/**
 * The intent was recorded and the action ran to a terminal state, but the outcome append itself
 * failed. Surfacing this failure — instead of a silent success — is a load-bearing invariant of
 * the bus. `originalActionExitTag` classifies how the action ended so the operator can decide how
 * to react; `appendFailureTag` names the underlying failure class (bounded, value-free — no raw
 * sink text or payload fragment is ever embedded here).
 */
export class TerminalOutcomeAppendFailure extends Data.TaggedError('TerminalOutcomeAppendFailure')<{
  readonly correlationId: string
  readonly originalActionExitTag: 'Success' | 'TypedFailure' | 'Defect' | 'Interrupt'
  readonly appendFailureTag: string
}> {}

/**
 * A resume/replay attempt encountered a correlationId that already has both an intent and an
 * outcome recorded in the file being resumed, and a caller is now attempting to record against
 * that same correlationId again. Raised distinctly from `DuplicateOutcomeFailure` so resume-time
 * drift is visible in metrics and error handling.
 */
export class DuplicateWithinRunFailure extends Data.TaggedError('DuplicateWithinRunFailure')<{
  readonly correlationId: string
  readonly runId: string
}> {}

/**
 * A resume operation failed to decode an existing on-disk line, or encountered a
 * duplicate/out-of-order sequence variant during replay, or found a line whose identity
 * (runId, persona/domain/skill triple, or scope containment) does not match what the caller
 * asked to resume. Includes the line offset (1-based) so a human can locate the offending line.
 * No raw line content, no raw parse-error text, and no literal payload excerpt is included — a
 * failure only exposes the `reason` code and `lineNumber` alongside the requested runId.
 *
 * `reason` values:
 *   - `invalid-json` — the line is not valid JSON.
 *   - `schema-mismatch` — the JSON does not match either envelope schema.
 *   - `protocol-version-mismatch` — the line's `protocolVersion` does not match the current
 *      supported literal.
 *   - `duplicate-intent` — the file contains a second intent for a correlationId that already
 *     has one earlier in the same file.
 *   - `duplicate-outcome` — the file contains a second outcome for a correlationId that already
 *     has one earlier in the same file.
 *   - `outcome-before-intent` — an outcome line appears in the file before any intent for its
 *     correlationId.
 *   - `run-id-mismatch` — the line's in-band `runId` does not match the run being resumed. A
 *     replay file cannot be contaminated by a line minted for a different run even if it were
 *     misfiled by name.
 *   - `scope-mismatch` — the line's persona/skill do not match the scope/file it was read from
 *     (e.g. a developer-domain event copied into an optimize-ux operator file, or vice versa).
 *     A replay for one scope cannot be contaminated by another scope's misfiled event.
 *   - `matrix-violation` — the line's persona/domain/skill triple fails the authoritative
 *     `validatePersonaMatrix` check even though it decoded structurally (e.g. an unknown
 *     personaId, or an operator persona paired with `optimize-dx`).
 */
export class ResumeDecodeFailure extends Data.TaggedError('ResumeDecodeFailure')<{
  readonly runId: string
  readonly lineNumber: number
  readonly reason:
    | 'invalid-json'
    | 'schema-mismatch'
    | 'protocol-version-mismatch'
    | 'duplicate-intent'
    | 'duplicate-outcome'
    | 'outcome-before-intent'
    | 'run-id-mismatch'
    | 'scope-mismatch'
    | 'matrix-violation'
}> {}

/**
 * A resume-time filesystem read failed for a reason OTHER than a missing file (ENOENT is a
 * benign "no prior run" signal and does not fail — permission-denied, I/O errors, etc. do).
 * Bounded, value-free: only the runId and a `errorCode` (best-effort Node error code) are
 * exposed; no raw underlying error message, no path fragment.
 */
export class ResumeReadFailure extends Data.TaggedError('ResumeReadFailure')<{
  readonly runId: string
  readonly errorCode: string
}> {}

export type AgentBusFailure =
  | IntentDecodeFailure
  | OutcomeDecodeFailure
  | OutcomePayloadDecodeFailure
  | IntentMissingFailure
  | IntentAckMismatchFailure
  | DuplicateIntentFailure
  | DuplicateOutcomeFailure
  | ProtocolVersionMismatchFailure
  | AgentBusWriteFailure
  | PersonaDomainSkillMismatchFailure
  | PathUnsafeIdentifierFailure
  | TerminalOutcomeAppendFailure
  | OutcomeAuthoringFailure
  | DuplicateWithinRunFailure
  | ResumeDecodeFailure
  | ResumeReadFailure
  | ConflictingRunOptionsFailure

/**
 * Callback shape for the third argument of `runWithIntent`. The CALLER authors an outcome for
 * every terminal exit shape — success, typed failure, unchecked defect, and interruption — using
 * the full `Exit`, the `IntentAck`, and a narrow immutable snapshot of the recorded intent. The
 * bus itself does NOT synthesize an outcome payload on the caller's behalf: only the caller has
 * the persona-specific domain knowledge (sensitivities, predictions, levers) to describe what
 * actually happened vs what they expected. The four exit shapes should produce four
 * distinguishable payloads, not the same boilerplate text.
 */
export type ToOutcome<A, E> = (
  exit: Exit.Exit<A, E>,
  ack: IntentAck,
  intent: IntentSnapshot,
) => OutcomeInputPayload

export interface AgentBusService {
  readonly recordIntent: (input: IntentInput) => Effect.Effect<IntentAck, AgentBusFailure>
  readonly recordOutcome: (
    ack: IntentAck,
    payload: OutcomeInputPayload,
  ) => Effect.Effect<void, AgentBusFailure>
  readonly runWithIntent: <A, E, R>(
    intent: IntentInput,
    action: (ack: IntentAck) => Effect.Effect<A, E, R>,
    toOutcome: ToOutcome<A, E>,
  ) => Effect.Effect<A, E | AgentBusFailure, R>
}

export class AgentBusTag extends Context.Tag('AgentBus')<AgentBusTag, AgentBusService>() {}

// ---------------------------------------------------------------------------------------------
// RunIdentity — Context.Tag capability that isolates run-id generation from the domain
// ---------------------------------------------------------------------------------------------

/**
 * Effect capability service for minting run identifiers. The domain module DECLARES the tag; the
 * live Node adapter in `./agent-bus-live.ts` provides `RunIdentityLive` as the ONLY place that
 * calls Node's UUID minting primitive. Test layers can supply a deterministic implementation
 * (fixed value or counter) so tests never depend on real randomness, mirroring how this repo
 * already isolates SDK/filesystem/clock/random capabilities elsewhere.
 */
export interface RunIdentity {
  readonly generate: Effect.Effect<string>
}

export class RunIdentityTag extends Context.Tag('AgentBus/RunIdentity')<
  RunIdentityTag,
  RunIdentity
>() {}

/**
 * Build a deterministic RunIdentity backed by a caller-supplied sequence. Each `generate` call
 * consumes the next value; running past the end fails with an explicit die so a test never
 * silently reuses the previous id.
 */
export function makeDeterministicRunIdentity(sequence: Iterable<string>): RunIdentity {
  const iterator = sequence[Symbol.iterator]()
  return {
    generate: Effect.sync(() => {
      const next = iterator.next()
      if (next.done) {
        throw new Error('makeDeterministicRunIdentity: sequence exhausted')
      }
      return next.value
    }),
  }
}

/**
 * Convenience: a RunIdentity that always returns the same fixed value. Handy for tests that
 * only need one deterministic run id.
 */
export function makeFixedRunIdentity(runId: string): RunIdentity {
  return {generate: Effect.succeed(runId)}
}

/**
 * Convenience Layer for tests: injects a fixed run id under `RunIdentityTag`. The live layer is
 * defined in `./agent-bus-live.ts` and MUST be used by anything that touches disk.
 */
export function makeDeterministicRunIdentityLayer(
  sequence: Iterable<string>,
): Layer.Layer<RunIdentityTag> {
  return Layer.succeed(RunIdentityTag, makeDeterministicRunIdentity(sequence))
}

// ---------------------------------------------------------------------------------------------
// Redaction (pure)
// ---------------------------------------------------------------------------------------------

// Labeled secret patterns. Every entry requires a preceding key= (or equivalent) label so that
// bare tokens that look like credentials but aren't (e.g. a 40-char commit SHA quoted in a
// prediction) do NOT get redacted. Redaction targets the value only, keeping the key visible so
// the reader can see what was scrubbed.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // GitHub personal / app / OAuth / user-to-server / refresh tokens (labeled by their prefix,
  // which is itself the credential shape — no separate key= needed).
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\bghs_[A-Za-z0-9]{20,}\b/g,
  /\bghr_[A-Za-z0-9]{20,}\b/g,
  // AWS access key ids — self-labeled by prefix.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWT-ish (three base64url segments separated by dots) — self-labeled by the eyJ header prefix.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // ****** — the word "Bearer" is the label.
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/g,
  // Labeled credential assignments — the key IS the label. Matches key=value with value >= 16
  // chars from the credential-shaped charset. Deliberately does NOT match bare hex/base64.
  /\b(pat|token|secret|password|pwd|apikey|api_key|accountkey|sharedaccesskey|connectionstring|conn_str|clientsecret|client_secret)\s*[:=]\s*['"]?[A-Za-z0-9._\-+/=]{16,}['"]?/gi,
]

export function redactSecrets(value: string): string {
  let redacted = value
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]')
  }
  return redacted
}

export function redactIntentEvent(event: IntentEvent): IntentEvent {
  return {
    ...event,
    perceivedInterface: redactSecrets(event.perceivedInterface),
    intendedAction: redactSecrets(event.intendedAction),
    expectedResult: redactSecrets(event.expectedResult),
  }
}

export function redactOutcomeEvent(event: OutcomeEvent): OutcomeEvent {
  return {
    ...event,
    actualResult: redactSecrets(event.actualResult),
    delta: redactSecrets(event.delta),
    observedFriction:
      event.observedFriction === undefined ? undefined : redactSecrets(event.observedFriction),
  }
}

// ---------------------------------------------------------------------------------------------
// Persona/domain/skill matrix + path safety (pure)
// ---------------------------------------------------------------------------------------------

const KNOWN_PERSONA_IDS: ReadonlySet<string> = new Set(
  PERSONA_DEFINITIONS.map((persona) => persona.id),
)
const KNOWN_OPERATOR_IDS: ReadonlySet<string> = new Set(OPERATOR_PERSONA_IDS)
const KNOWN_DEVELOPER_IDS: ReadonlySet<string> = new Set(DEVELOPER_PERSONA_IDS)

// Upper bound for any identifier that will be embedded in a path segment. UUIDs are 36 chars;
// this is generous enough for other reasonable ids (e.g. `resume-1`) but rejects pathological
// values that could evade downstream length checks.
const MAX_PATH_IDENTIFIER_LENGTH = 128

export function validatePathSafety(
  field: 'personaId' | 'runId' | 'resumeFromRunId',
  value: string,
): Either.Either<string, PathUnsafeIdentifierFailure> {
  if (value.length === 0) {
    return Either.left(new PathUnsafeIdentifierFailure({field, reason: 'empty'}))
  }
  if (value.length > MAX_PATH_IDENTIFIER_LENGTH) {
    return Either.left(new PathUnsafeIdentifierFailure({field, reason: 'too-long'}))
  }
  if (value.includes('\0')) {
    return Either.left(new PathUnsafeIdentifierFailure({field, reason: 'contains-null-byte'}))
  }
  if (value.includes('/') || value.includes('\\')) {
    return Either.left(new PathUnsafeIdentifierFailure({field, reason: 'contains-path-separator'}))
  }
  if (value.includes('..')) {
    return Either.left(new PathUnsafeIdentifierFailure({field, reason: 'contains-dotdot'}))
  }
  return Either.right(value)
}

export function validatePersonaMatrix(
  input: IntentInput,
): Either.Either<IntentInput, PersonaDomainSkillMismatchFailure | PathUnsafeIdentifierFailure> {
  const pathCheck = validatePathSafety('personaId', input.personaId)
  if (Either.isLeft(pathCheck)) {
    return Either.left(pathCheck.left)
  }
  if (!KNOWN_PERSONA_IDS.has(input.personaId)) {
    return Either.left(
      new PersonaDomainSkillMismatchFailure({
        personaId: input.personaId,
        domain: input.domain,
        skill: input.skill,
        reason: 'unknown-persona',
      }),
    )
  }
  const isOperator = KNOWN_OPERATOR_IDS.has(input.personaId)
  const isDeveloper = KNOWN_DEVELOPER_IDS.has(input.personaId)
  if (input.domain === 'operator' && !isOperator) {
    return Either.left(
      new PersonaDomainSkillMismatchFailure({
        personaId: input.personaId,
        domain: input.domain,
        skill: input.skill,
        reason: 'domain-persona-mismatch',
      }),
    )
  }
  if (input.domain === 'developer' && !isDeveloper) {
    return Either.left(
      new PersonaDomainSkillMismatchFailure({
        personaId: input.personaId,
        domain: input.domain,
        skill: input.skill,
        reason: 'domain-persona-mismatch',
      }),
    )
  }
  if (input.domain === 'operator' && input.skill !== 'optimize-ux') {
    return Either.left(
      new PersonaDomainSkillMismatchFailure({
        personaId: input.personaId,
        domain: input.domain,
        skill: input.skill,
        reason: 'operator-skill-mismatch',
      }),
    )
  }
  if (input.domain === 'developer' && input.skill !== 'optimize-dx') {
    return Either.left(
      new PersonaDomainSkillMismatchFailure({
        personaId: input.personaId,
        domain: input.domain,
        skill: input.skill,
        reason: 'developer-skill-mismatch',
      }),
    )
  }
  return Either.right(input)
}

/**
 * Derive the `AgentBusDomain` for a persona id from the authoritative
 * `PERSONA_DEFINITIONS`/`OPERATOR_PERSONA_IDS`/`DEVELOPER_PERSONA_IDS` split. Returns
 * `undefined` when the persona is not in the roster — callers should route that through
 * `validatePersonaMatrix` so an unknown persona surfaces the correct typed failure.
 */
export function deriveDomainFromPersonaId(personaId: string): AgentBusDomain | undefined {
  if (KNOWN_OPERATOR_IDS.has(personaId)) return 'operator'
  if (KNOWN_DEVELOPER_IDS.has(personaId)) return 'developer'
  return undefined
}

/**
 * Validate a resume scope's (personaId, skill) pair against the authoritative matrix by
 * deriving the domain from the persona id and then running the same `validatePersonaMatrix`
 * check the intent path uses. Item 6: guarantees a resume scope with a mismatched
 * persona/domain/skill triple is rejected BEFORE any filesystem access.
 */
export function validateResumeScopeMatrix(scope: {
  readonly personaId: string
  readonly skill: AgentBusSkill
}): Either.Either<
  {readonly personaId: string; readonly skill: AgentBusSkill; readonly domain: AgentBusDomain},
  PersonaDomainSkillMismatchFailure | PathUnsafeIdentifierFailure
> {
  const pathCheck = validatePathSafety('personaId', scope.personaId)
  if (Either.isLeft(pathCheck)) {
    return Either.left(pathCheck.left)
  }
  const derived = deriveDomainFromPersonaId(scope.personaId)
  // If the persona is unknown, deriveDomain returns undefined. Route through
  // validatePersonaMatrix with an arbitrary domain so we get the `unknown-persona` typed
  // failure (the domain field on the failure is informational — the reason code is what
  // callers switch on).
  const domainForCheck: AgentBusDomain =
    derived ?? (scope.skill === 'optimize-ux' ? 'operator' : 'developer')
  const synthetic: IntentInput = {
    correlationId: `resume-scope:${scope.personaId}:${scope.skill}`,
    personaId: scope.personaId,
    domain: domainForCheck,
    skill: scope.skill,
    iteration: 1,
    perceivedInterface: '',
    intendedAction: '',
    expectedResult: '',
  }
  const matrixCheck = validatePersonaMatrix(synthetic)
  if (Either.isLeft(matrixCheck)) {
    return Either.left(matrixCheck.left)
  }
  // At this point the persona is known and derived is defined.
  return Either.right({personaId: scope.personaId, skill: scope.skill, domain: domainForCheck})
}

// ---------------------------------------------------------------------------------------------
// Core bus
// ---------------------------------------------------------------------------------------------

interface CorrelationState {
  readonly intent: IntentEvent
  readonly outcome: OutcomeEvent | null
}

export interface BusStore {
  readonly correlations: Map<string, CorrelationState>
}

export function makeEmptyStore(): BusStore {
  return {correlations: new Map()}
}

function currentIsoInstant(): Effect.Effect<string> {
  return Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString())
}

/**
 * Abstract event sink the domain uses to persist recorded events. Live adapters (filesystem,
 * remote sink) implement this. Test/in-memory implementations either drop events or record them
 * into a Ref for inspection.
 */
export interface CoreEventSink {
  readonly onIntent: (event: IntentEvent) => Effect.Effect<void, AgentBusWriteFailure>
  readonly onOutcome: (
    event: OutcomeEvent,
    intent: IntentEvent,
  ) => Effect.Effect<void, AgentBusWriteFailure>
}

export interface CoreBusOptions {
  readonly runId: string
  readonly initialStore?: BusStore
  readonly resumeRunId?: string
}

function classifyActionExit<A, E>(
  exit: Exit.Exit<A, E>,
): 'Success' | 'TypedFailure' | 'Defect' | 'Interrupt' {
  if (Exit.isSuccess(exit)) return 'Success'
  const cause = exit.cause
  if (Cause.isInterruptedOnly(cause)) return 'Interrupt'
  if (Cause.isDie(cause)) return 'Defect'
  return 'TypedFailure'
}

/**
 * Build an `AgentBusService` around an abstract event sink. Owns the correlation index, the
 * intent/outcome sequencing, protocol-version verification, schema decoding, and the
 * `runWithIntent` uninterruptible outcome-append region. Pure — no filesystem or randomness
 * calls.
 */
export function makeAgentBusFromSink(
  sink: CoreEventSink,
  options: CoreBusOptions,
): Effect.Effect<AgentBusService> {
  return Effect.gen(function* () {
    const stateRef = yield* Ref.make<BusStore>(options.initialStore ?? makeEmptyStore())
    const runId = options.runId
    const resumeRunId = options.resumeRunId
    // Per-service domain-level mutex. Serializes the ENTIRE logical check + sink-append +
    // state-update transaction inside `recordIntent` and `recordOutcome` so two concurrent
    // calls for the SAME correlationId on the SAME service instance cannot both pass the
    // "does this already exist" check before either commits its append/state-update. Without
    // this, the live adapter's per-write file semaphore only serializes the physical file
    // append and NOT the logical transaction, letting two racing intents (or two racing
    // outcomes) both slip past the duplicate check and produce a run that cannot cleanly
    // resume.
    //
    // Scope of serialization is deliberately per-service-instance (not global across all
    // instances, not per-correlationId). Distinct `AgentBusService` instances — for example
    // an operator bus and a developer bus, or two independently-constructed test bus
    // instances — hold DIFFERENT semaphores and remain fully concurrent with each other.
    // Correctness within one service is prioritized over intra-service parallelism per the
    // architecture note in `AGENTS.md`'s write-ahead protocol.
    //
    // Critical invariant: this mutex must NOT be held across the caller-authored `action`
    // inside `runWithIntent`. `runWithIntent` calls `recordIntent` (acquires + releases),
    // then runs `action` with no bus lock held, then calls `recordOutcome` (acquires +
    // releases). Holding the mutex across `action` would serialize unrelated work and, if
    // `action` itself re-enters the bus for a different correlationId on the same service,
    // deadlock. Verified in tests that a full `runWithIntent` completes and that two
    // concurrent `runWithIntent` calls with DIFFERENT correlationIds both complete.
    const busMutex = yield* Effect.makeSemaphore(1)

    const verifyProtocolVersion = (
      provided: string | undefined,
    ): Either.Either<string, ProtocolVersionMismatchFailure> => {
      if (provided === undefined) {
        return Either.right(AGENT_BUS_PROTOCOL_VERSION)
      }
      if (provided !== AGENT_BUS_PROTOCOL_VERSION) {
        return Either.left(
          new ProtocolVersionMismatchFailure({
            expected: AGENT_BUS_PROTOCOL_VERSION,
            actual: provided,
          }),
        )
      }
      return Either.right(provided)
    }

    const decodeIntent = (input: IntentInput, recordedAt: string, protocolVersion: string) =>
      Either.mapLeft(
        Schema.decodeUnknownEither(IntentEventSchema, {onExcessProperty: 'error'})({
          runId,
          correlationId: input.correlationId,
          personaId: input.personaId,
          domain: input.domain,
          skill: input.skill,
          iteration: input.iteration,
          perceivedInterface: input.perceivedInterface,
          intendedAction: input.intendedAction,
          expectedResult: input.expectedResult,
          protocolVersion,
          recordedAt,
        }),
        () =>
          // Value-free: only the correlationId (caller-controlled structural metadata) is
          // exposed. The raw parse-error text is DELIBERATELY omitted so a caller who logs the
          // failure cannot surface a payload fragment that decode may have echoed back.
          new IntentDecodeFailure({correlationId: input.correlationId}),
      )

    const decodeOutcomePayload = (payload: OutcomeInputPayload, correlationId: string) =>
      Either.mapLeft(
        Schema.decodeUnknownEither(OutcomeInputPayloadSchema, {onExcessProperty: 'error'})(
          payload as unknown,
        ),
        () => new OutcomePayloadDecodeFailure({correlationId}),
      )

    const decodeOutcome = (
      correlationId: string,
      payload: OutcomeInputPayload,
      recordedAt: string,
      protocolVersion: string,
    ) => {
      const record: Record<string, unknown> = {
        runId,
        correlationId,
        actualResult: payload.actualResult,
        delta: payload.delta,
        desirability: payload.desirability,
        degree: payload.degree,
        protocolVersion,
        recordedAt,
      }
      if (payload.observedFriction !== undefined) {
        record.observedFriction = payload.observedFriction
      }
      return Either.mapLeft(
        Schema.decodeUnknownEither(OutcomeEventSchema, {onExcessProperty: 'error'})(record),
        () => new OutcomeDecodeFailure({correlationId}),
      )
    }

    const recordIntent = (input: IntentInput): Effect.Effect<IntentAck, AgentBusFailure> =>
      busMutex.withPermits(1)(
        Effect.gen(function* () {
          const matrixCheck = validatePersonaMatrix(input)
          yield* Either.match(matrixCheck, {
            onLeft: (failure) => Effect.fail<AgentBusFailure>(failure),
            onRight: () => Effect.void,
          })
          const versionCheck = verifyProtocolVersion(input.protocolVersion)
          const protocolVersion = yield* Either.match(versionCheck, {
            onLeft: (failure) => Effect.fail<AgentBusFailure>(failure),
            onRight: (value) => Effect.succeed(value),
          })
          const recordedAt = yield* currentIsoInstant()
          const decoded = decodeIntent(input, recordedAt, protocolVersion)
          const event = yield* Either.match(decoded, {
            onLeft: (failure) => Effect.fail<AgentBusFailure>(failure),
            onRight: (value) => Effect.succeed(value),
          })
          const existing = yield* Ref.get(stateRef).pipe(
            Effect.map((store) => store.correlations.get(event.correlationId)),
          )
          if (existing !== undefined) {
            if (resumeRunId !== undefined) {
              return yield* Effect.fail<AgentBusFailure>(
                new DuplicateWithinRunFailure({
                  correlationId: event.correlationId,
                  runId: resumeRunId,
                }),
              )
            }
            return yield* Effect.fail<AgentBusFailure>(
              new DuplicateIntentFailure({correlationId: event.correlationId}),
            )
          }
          yield* sink.onIntent(event)
          yield* Ref.update(stateRef, (store) => {
            const next = new Map(store.correlations)
            next.set(event.correlationId, {intent: event, outcome: null})
            return {correlations: next}
          })
          return makeIntentAck(event.correlationId, event.recordedAt, runId)
        }),
      )

    const recordOutcome = (
      ack: IntentAck,
      payload: OutcomeInputPayload,
    ): Effect.Effect<void, AgentBusFailure> =>
      busMutex.withPermits(1)(
        Effect.gen(function* () {
          // Item 1: verify the ack actually belongs to THIS bus instance/run BEFORE decoding or
          // touching the correlation index. `ack.runId` must match the bus's own runId, and the
          // stored intent's `recordedAt` must match the ack's — this defends against a
          // same-correlationId ack minted by a different intent record (e.g. after a hypothetical
          // re-create) as well as a cross-bus ack pass-through. Both checks return typed
          // `IntentAckMismatchFailure` so the caller cannot resolve an intent through this bus
          // that this bus did not itself issue an ack for.
          if (ack.runId !== runId) {
            return yield* Effect.fail<AgentBusFailure>(
              new IntentAckMismatchFailure({
                correlationId: ack.correlationId,
                reason: 'run-id-mismatch',
              }),
            )
          }
          const payloadCheck = decodeOutcomePayload(payload, ack.correlationId)
          yield* Either.match(payloadCheck, {
            onLeft: (failure) => Effect.fail<AgentBusFailure>(failure),
            onRight: () => Effect.void,
          })
          const versionCheck = verifyProtocolVersion(payload.protocolVersion)
          const protocolVersion = yield* Either.match(versionCheck, {
            onLeft: (failure) => Effect.fail<AgentBusFailure>(failure),
            onRight: (value) => Effect.succeed(value),
          })
          const recordedAt = yield* currentIsoInstant()
          // Correlation comes from the ack — never from the payload. A caller cannot claim a
          // correlationId it did not receive an ack for.
          const decoded = decodeOutcome(ack.correlationId, payload, recordedAt, protocolVersion)
          const event = yield* Either.match(decoded, {
            onLeft: (failure) => Effect.fail<AgentBusFailure>(failure),
            onRight: (value) => Effect.succeed(value),
          })
          const state = yield* Ref.get(stateRef).pipe(
            Effect.map((store) => store.correlations.get(event.correlationId)),
          )
          if (state === undefined) {
            return yield* Effect.fail<AgentBusFailure>(
              new IntentMissingFailure({correlationId: event.correlationId}),
            )
          }
          // Item 1: even inside this bus, the ack's `recordedAt` must match the stored intent's
          // `recordedAt`. This guards against a stale ack that was minted for a prior intent
          // record which has since been replaced (a defence-in-depth invariant — the bus itself
          // does not currently offer a re-create path, but preventing this leak future-proofs
          // the API and rejects deliberately-forged acks that guess a correlationId).
          if (ack.recordedAt !== state.intent.recordedAt) {
            return yield* Effect.fail<AgentBusFailure>(
              new IntentAckMismatchFailure({
                correlationId: ack.correlationId,
                reason: 'recorded-at-mismatch',
              }),
            )
          }
          if (state.outcome !== null) {
            if (resumeRunId !== undefined) {
              return yield* Effect.fail<AgentBusFailure>(
                new DuplicateWithinRunFailure({
                  correlationId: event.correlationId,
                  runId: resumeRunId,
                }),
              )
            }
            return yield* Effect.fail<AgentBusFailure>(
              new DuplicateOutcomeFailure({correlationId: event.correlationId}),
            )
          }
          yield* sink.onOutcome(event, state.intent)
          yield* Ref.update(stateRef, (store) => {
            const next = new Map(store.correlations)
            next.set(event.correlationId, {intent: state.intent, outcome: event})
            return {correlations: next}
          })
        }),
      )

    const runWithIntent = <A, E, R>(
      intent: IntentInput,
      action: (ack: IntentAck) => Effect.Effect<A, E, R>,
      toOutcome: ToOutcome<A, E>,
    ): Effect.Effect<A, E | AgentBusFailure, R> =>
      // The action only runs after `recordIntent` succeeds — its input `ack` cannot exist until
      // the intent has been appended and confirmed by the sink. From that point on, we run inside
      // `uninterruptibleMask` so that even if the surrounding fiber is interrupted, the outcome
      // append is still attempted for the action that had already begun.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ack = yield* recordIntent(intent)
          const state = yield* Ref.get(stateRef).pipe(
            Effect.map((store) => store.correlations.get(ack.correlationId)),
          )
          // `state` MUST be defined here — recordIntent just successfully inserted it. Guarded
          // for TS narrowing; a missing entry would be an internal bug, not a caller error.
          if (state === undefined) {
            return yield* Effect.fail<AgentBusFailure>(
              new IntentMissingFailure({correlationId: ack.correlationId}),
            )
          }
          const snapshot = toIntentSnapshot(state.intent)
          // `restore` re-enables interruption for the action itself, so callers can still cancel
          // it. `Effect.exit` reifies every terminal shape — success, typed failure, defect,
          // interrupt — into an inspectable Exit for classification.
          const actionExit = yield* Effect.exit(restore(action(ack)))
          const originalExitTag = classifyActionExit(actionExit)
          // Item 5: `toOutcome` is authored by the CALLER and may throw. If we invoke it as a
          // plain function call, an exception becomes an Effect defect and the outcome append
          // is silently skipped — contradicting the attempt-guarantee wording. Wrap it in
          // `Effect.try` so a throw surfaces as a typed `OutcomeAuthoringFailure` (bounded,
          // value-free — only the exit-tag classification is attached for diagnostics; the
          // thrown error's raw text is NEVER embedded). Per the updated
          // TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION, this specific case is a carved-out
          // exception to the attempt-guarantee: no outcome record is written for it. The
          // pinned doc-drift test enforces that AGENTS.md quotes the updated wording.
          const authoredExit = yield* Effect.exit(
            Effect.try({
              try: () => toOutcome(actionExit, ack, snapshot),
              catch: () =>
                new OutcomeAuthoringFailure({
                  correlationId: ack.correlationId,
                  originalActionExitTag: originalExitTag,
                }),
            }),
          )
          if (Exit.isFailure(authoredExit)) {
            const authoringFailure = Cause.failureOption(authoredExit.cause)
            if (authoringFailure._tag === 'Some') {
              return yield* Effect.fail<AgentBusFailure>(authoringFailure.value)
            }
            // Extremely defensive fallback — if the try/catch above somehow produced a defect,
            // still surface a bounded OutcomeAuthoringFailure rather than let raw defect text
            // through. Keeps the guarantee honest.
            return yield* Effect.fail<AgentBusFailure>(
              new OutcomeAuthoringFailure({
                correlationId: ack.correlationId,
                originalActionExitTag: originalExitTag,
              }),
            )
          }
          const outcomePayload = authoredExit.value
          // The outcome append itself must remain uninterruptible — we already excluded `restore`
          // from this block — so an external interrupt cannot skip persisting the terminal
          // outcome for an intent we already recorded.
          const outcomeExit = yield* Effect.exit(recordOutcome(ack, outcomePayload))
          if (Exit.isSuccess(outcomeExit)) {
            // Re-surface the original action exit unchanged. Callers of `runWithIntent` see
            // exactly what the action would have produced.
            return yield* actionExit
          }
          // Outcome append failed. We surface a distinct TerminalOutcomeAppendFailure that wraps
          // the classification of the original action exit for diagnostics — the append failure
          // itself is never swallowed. `appendFailureTag` is derived from the failure's tag
          // only (value-free per item 4) so no raw sink text or payload leaks into the error.
          const appendTag = summarizeAppendFailureTag(outcomeExit.cause)
          return yield* Effect.fail<AgentBusFailure>(
            new TerminalOutcomeAppendFailure({
              correlationId: ack.correlationId,
              originalActionExitTag: originalExitTag,
              appendFailureTag: appendTag,
            }),
          )
        }),
      )

    return {recordIntent, recordOutcome, runWithIntent}
  })
}

/**
 * Summarize a failed outcome-append cause as a bounded tag string. Extracts only the tag/class
 * name of the first tagged failure or die — NEVER raw messages, payload text, or `Cause.pretty`
 * output. This keeps `TerminalOutcomeAppendFailure.appendFailureTag` value-free per item 4.
 */
function summarizeAppendFailureTag(cause: Cause.Cause<AgentBusFailure>): string {
  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') {
    const value = failure.value as {readonly _tag?: string}
    return value._tag ?? 'UnknownFailure'
  }
  const die = Cause.dieOption(cause)
  if (die._tag === 'Some') {
    return 'Defect'
  }
  if (Cause.isInterruptedOnly(cause)) {
    return 'Interrupted'
  }
  return 'UnclassifiedAppendFailure'
}

// ---------------------------------------------------------------------------------------------
// Test services — deterministic, in-memory. No filesystem, no randomness.
// ---------------------------------------------------------------------------------------------

const DEFAULT_TEST_RUN_ID = 'test-run'

/** Deterministic in-memory service. Uses Effect's Clock. No filesystem, no cross-test state. */
export const makeAgentBusTestService = (
  options: {readonly runId?: string} = {},
): Effect.Effect<AgentBusService> =>
  Effect.gen(function* () {
    const sink: CoreEventSink = {
      onIntent: () => Effect.void,
      onOutcome: () => Effect.void,
    }
    return yield* makeAgentBusFromSink(sink, {runId: options.runId ?? DEFAULT_TEST_RUN_ID})
  })

export const AgentBusTestLayer = Layer.effect(AgentBusTag, makeAgentBusTestService())

/** In-memory service that also records every appended intent/outcome for inspection in tests. */
export interface RecordingAgentBus {
  readonly service: AgentBusService
  readonly intents: () => Effect.Effect<ReadonlyArray<IntentEvent>>
  readonly outcomes: () => Effect.Effect<ReadonlyArray<OutcomeEvent>>
}

export const makeRecordingAgentBus = (
  options: {readonly runId?: string} = {},
): Effect.Effect<RecordingAgentBus> =>
  Effect.gen(function* () {
    const intentsRef = yield* Ref.make<ReadonlyArray<IntentEvent>>([])
    const outcomesRef = yield* Ref.make<ReadonlyArray<OutcomeEvent>>([])
    const sink: CoreEventSink = {
      onIntent: (event) => Ref.update(intentsRef, (existing) => [...existing, event]),
      onOutcome: (event) => Ref.update(outcomesRef, (existing) => [...existing, event]),
    }
    const service = yield* makeAgentBusFromSink(sink, {
      runId: options.runId ?? DEFAULT_TEST_RUN_ID,
    })
    return {
      service,
      intents: () => Ref.get(intentsRef),
      outcomes: () => Ref.get(outcomesRef),
    }
  })

/**
 * In-memory service whose outcome-sink is instrumented to fail. Used by tests to prove that a
 * terminal outcome append failure is surfaced (never swallowed). The `errorCode` argument is
 * an opaque, bounded tag the caller can identify in assertions; the sink NEVER embeds raw
 * payload text.
 */
export const makeFailingOutcomeAgentBus = (
  errorCode: string = 'INJECTED_OUTCOME_SINK_FAILURE',
  options: {readonly runId?: string} = {},
): Effect.Effect<AgentBusService> =>
  Effect.gen(function* () {
    const sink: CoreEventSink = {
      onIntent: () => Effect.void,
      onOutcome: () => Effect.fail(new AgentBusWriteFailure({errorCode})),
    }
    return yield* makeAgentBusFromSink(sink, {runId: options.runId ?? DEFAULT_TEST_RUN_ID})
  })
