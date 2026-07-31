// Shared write-ahead persona bus.
//
// Purpose: prevent outcome-bias contamination when a persona (operator or contributor) records
// what it expected an interaction to do vs. what actually happened. Every observation must go
// through a two-phase intent -> outcome ordering that is structurally enforced by the API
// surface, not merely by convention. A terminal outcome is guaranteed to be attempted for every
// intent that was recorded — success, typed failure, unchecked defect, or interruption — so the
// on-disk stream is never left with a dangling intent hiding an unreported action result.
//
// Two phases:
//   1. `recordIntent` — the persona describes what interface it perceives, the action it intends,
//      and the result it expects. This MUST be appended and confirmed before any downstream action
//      runs. On success the caller receives a branded, non-forgeable `IntentAck` token.
//   2. `recordOutcome(ack, payload)` — the persona reports the actual result, a delta description,
//      and a bounded desirability judgment. The persisted `correlationId` is taken from the ack —
//      the caller does not supply it — so a caller cannot claim an outcome for a correlationId it
//      never received a real ack for. Each correlationId may only be resolved once.
//
// `runWithIntent` is the critical anti-outcome-bias primitive. Because the action closure receives
// the `IntentAck` returned by `recordIntent`, and `IntentAck` is only produced when the intent has
// been successfully appended, it is a type error to run the action before the intent write
// succeeds. There is no way to fabricate an `IntentAck`, no method to mutate a recorded intent,
// and no method to delete an intent — the persona cannot fake a write-ahead after seeing the
// outcome, and cannot silently "update" its prediction to match reality.
//
// See `DESIRABILITY_SCALE_DESCRIPTION` for the single, authoritative wording of the `degree`
// scale. AGENTS.md quotes that constant verbatim; a documentation contract test asserts they can
// never silently drift apart.

import {randomUUID} from 'node:crypto'
import {appendFile, mkdir, readFile, stat} from 'node:fs/promises'
import path from 'node:path'
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

export const AgentBusDomainSchema = Schema.Literal('operator', 'developer')
export type AgentBusDomain = Schema.Schema.Type<typeof AgentBusDomainSchema>

export const AgentBusSkillSchema = Schema.Literal('optimize-ux', 'optimize-dx')
export type AgentBusSkill = Schema.Schema.Type<typeof AgentBusSkillSchema>

export const DesirabilitySchema = Schema.Literal('desirable', 'neutral', 'undesirable')
export type Desirability = Schema.Schema.Type<typeof DesirabilitySchema>

export const IntentEventSchema = Schema.Struct({
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
 * is taken from the ack — the caller does NOT supply it. Passing a `correlationId` key here has
 * no effect and is not part of the payload contract; keep the concern of "which intent did this
 * resolve" bound to the ack.
 */
export interface OutcomeInputPayload {
  readonly actualResult: string
  readonly delta: string
  readonly desirability: Desirability
  readonly degree: number
  readonly observedFriction?: string
  readonly protocolVersion?: string
}

/**
 * Legacy alias retained so callers that already type their `toOutcome` closures as `OutcomeInput`
 * still compile against the new `runWithIntent` signature. A `correlationId` field, if present, is
 * silently ignored — the ack's `correlationId` is authoritative. New code should use
 * `OutcomeInputPayload` and let `recordOutcome`/`runWithIntent` handle correlation via the ack.
 */
export type OutcomeInput = OutcomeInputPayload & {
  readonly correlationId?: string
}

// Module-scoped unique symbol used as a brand on IntentAck. Because this symbol is not exported,
// an external caller cannot reference it, and therefore cannot construct an object literal that
// satisfies the IntentAck interface — only a successful `recordIntent` call (internal to this
// module) can produce one. `as IntentAck` casts still work, but that is a deliberate compile-time
// escape hatch, not a public API surface.
const IntentAckBrand: unique symbol = Symbol('AgentBus/IntentAckBrand')

export interface IntentAck {
  readonly correlationId: string
  readonly recordedAt: string
  readonly [IntentAckBrand]: true
}

function makeIntentAck(correlationId: string, recordedAt: string): IntentAck {
  return {correlationId, recordedAt, [IntentAckBrand]: true}
}

export class IntentDecodeFailure extends Data.TaggedError('IntentDecodeFailure')<{
  readonly message: string
}> {}

export class OutcomeDecodeFailure extends Data.TaggedError('OutcomeDecodeFailure')<{
  readonly message: string
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

export class AgentBusWriteFailure extends Data.TaggedError('AgentBusWriteFailure')<{
  readonly message: string
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
 * Persona id fails the defensive path-safety charset check (contains `/`, `\`, `..`, or null
 * bytes). Raised before any file path is constructed. This is defence-in-depth on top of the
 * enumerated persona/domain/skill matrix.
 */
export class PathUnsafeIdentifierFailure extends Data.TaggedError('PathUnsafeIdentifierFailure')<{
  readonly field: 'personaId'
  readonly reason: 'contains-path-separator' | 'contains-dotdot' | 'contains-null-byte'
}> {}

/**
 * The intent was recorded and the action ran to a terminal state, but the outcome append itself
 * failed. Surfacing this failure — instead of a silent success — is a load-bearing invariant of
 * the bus. `originalActionExitTag` classifies how the action ended so the operator can decide how
 * to react; the underlying failure message is included for diagnostics but the original raw
 * action payload is NOT embedded here.
 */
export class TerminalOutcomeAppendFailure extends Data.TaggedError('TerminalOutcomeAppendFailure')<{
  readonly correlationId: string
  readonly originalActionExitTag: 'Success' | 'TypedFailure' | 'Defect' | 'Interrupt'
  readonly appendFailureMessage: string
}> {}

/**
 * A resume/replay attempt encountered a correlationId that already has both an intent and an
 * outcome recorded in the file being resumed. Raised distinctly from `DuplicateOutcomeFailure` so
 * resume-time drift is visible in metrics and error handling.
 */
export class DuplicateWithinRunFailure extends Data.TaggedError('DuplicateWithinRunFailure')<{
  readonly correlationId: string
  readonly runId: string
}> {}

/**
 * A resume operation failed to decode an existing on-disk line. Includes the line offset (1-based)
 * so a human can locate the torn write or version-mismatch line. The raw line content is not
 * included to avoid leaking (potentially still-redacted, but conservatively-omitted) payload.
 */
export class ResumeDecodeFailure extends Data.TaggedError('ResumeDecodeFailure')<{
  readonly runId: string
  readonly lineNumber: number
  readonly reason: 'invalid-json' | 'schema-mismatch' | 'protocol-version-mismatch'
  readonly message: string
}> {}

export type AgentBusFailure =
  | IntentDecodeFailure
  | OutcomeDecodeFailure
  | IntentMissingFailure
  | DuplicateIntentFailure
  | DuplicateOutcomeFailure
  | ProtocolVersionMismatchFailure
  | AgentBusWriteFailure
  | PersonaDomainSkillMismatchFailure
  | PathUnsafeIdentifierFailure
  | TerminalOutcomeAppendFailure
  | DuplicateWithinRunFailure
  | ResumeDecodeFailure

export interface AgentBusService {
  readonly recordIntent: (input: IntentInput) => Effect.Effect<IntentAck, AgentBusFailure>
  readonly recordOutcome: (
    ack: IntentAck,
    payload: OutcomeInputPayload,
  ) => Effect.Effect<void, AgentBusFailure>
  readonly runWithIntent: <A, E, R>(
    intent: IntentInput,
    action: (ack: IntentAck) => Effect.Effect<A, E, R>,
    toOutcome: (result: A, ack: IntentAck) => OutcomeInputPayload,
  ) => Effect.Effect<A, E | AgentBusFailure, R>
}

export class AgentBusTag extends Context.Tag('AgentBus')<AgentBusTag, AgentBusService>() {}

// ---------------------------------------------------------------------------------------------
// RunIdentity
// ---------------------------------------------------------------------------------------------

/**
 * Optional Context.Tag service for injecting a deterministic runId in tests. The live bus does
 * NOT require this tag — it generates a fresh `crypto.randomUUID()` per service instance by
 * default — but a caller who wants full determinism can pass an explicit `runId` through the
 * `makeAgentBusLiveService` options.
 */
export interface RunIdentity {
  readonly generate: Effect.Effect<string>
}

export class RunIdentityTag extends Context.Tag('AgentBus/RunIdentity')<
  RunIdentityTag,
  RunIdentity
>() {}

export const RunIdentityLive: Layer.Layer<RunIdentityTag> = Layer.succeed(RunIdentityTag, {
  generate: Effect.sync(() => randomUUID()),
})

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

// ---------------------------------------------------------------------------------------------
// Redaction
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
  // Bearer token — the word "Bearer" is the label.
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

function redactIntentEvent(event: IntentEvent): IntentEvent {
  return {
    ...event,
    perceivedInterface: redactSecrets(event.perceivedInterface),
    intendedAction: redactSecrets(event.intendedAction),
    expectedResult: redactSecrets(event.expectedResult),
  }
}

function redactOutcomeEvent(event: OutcomeEvent): OutcomeEvent {
  return {
    ...event,
    actualResult: redactSecrets(event.actualResult),
    delta: redactSecrets(event.delta),
    observedFriction:
      event.observedFriction === undefined ? undefined : redactSecrets(event.observedFriction),
  }
}

// ---------------------------------------------------------------------------------------------
// Persona/domain/skill matrix + path safety
// ---------------------------------------------------------------------------------------------

const KNOWN_PERSONA_IDS: ReadonlySet<string> = new Set(
  PERSONA_DEFINITIONS.map((persona) => persona.id),
)
const KNOWN_OPERATOR_IDS: ReadonlySet<string> = new Set(OPERATOR_PERSONA_IDS)
const KNOWN_DEVELOPER_IDS: ReadonlySet<string> = new Set(DEVELOPER_PERSONA_IDS)

function validatePathSafety(personaId: string): Either.Either<string, PathUnsafeIdentifierFailure> {
  if (personaId.includes('\0')) {
    return Either.left(
      new PathUnsafeIdentifierFailure({field: 'personaId', reason: 'contains-null-byte'}),
    )
  }
  if (personaId.includes('/') || personaId.includes('\\')) {
    return Either.left(
      new PathUnsafeIdentifierFailure({field: 'personaId', reason: 'contains-path-separator'}),
    )
  }
  if (personaId.includes('..')) {
    return Either.left(
      new PathUnsafeIdentifierFailure({field: 'personaId', reason: 'contains-dotdot'}),
    )
  }
  return Either.right(personaId)
}

function validatePersonaMatrix(
  input: IntentInput,
): Either.Either<IntentInput, PersonaDomainSkillMismatchFailure | PathUnsafeIdentifierFailure> {
  const pathCheck = validatePathSafety(input.personaId)
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

// ---------------------------------------------------------------------------------------------
// Core bus
// ---------------------------------------------------------------------------------------------

interface CorrelationState {
  readonly intent: IntentEvent
  readonly outcome: OutcomeEvent | null
}

interface BusStore {
  readonly correlations: Map<string, CorrelationState>
}

function makeEmptyStore(): BusStore {
  return {correlations: new Map()}
}

function currentIsoInstant(): Effect.Effect<string> {
  return Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString())
}

interface CoreEventSink {
  readonly onIntent: (event: IntentEvent) => Effect.Effect<void, AgentBusWriteFailure>
  readonly onOutcome: (
    event: OutcomeEvent,
    intent: IntentEvent,
  ) => Effect.Effect<void, AgentBusWriteFailure>
}

interface CoreBusOptions {
  readonly initialStore?: BusStore
  readonly runId?: string
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

function terminalOutcomeForFailure(
  ack: IntentAck,
  exitTag: 'TypedFailure' | 'Defect' | 'Interrupt',
): OutcomeInputPayload {
  const label =
    exitTag === 'Interrupt'
      ? 'action interrupted before producing a result'
      : exitTag === 'Defect'
        ? 'action died with an unchecked defect'
        : 'action failed with a typed domain failure'
  return {
    actualResult: `no result — ${label} (correlationId=${ack.correlationId})`,
    delta: `no comparison available — action did not reach a success value (${exitTag})`,
    desirability: 'undesirable',
    degree: 0,
    observedFriction: exitTag,
  }
}

function makeAgentBusFromSink(
  sink: CoreEventSink,
  options: CoreBusOptions = {},
): Effect.Effect<AgentBusService> {
  return Effect.gen(function* () {
    const stateRef = yield* Ref.make<BusStore>(options.initialStore ?? makeEmptyStore())
    const resumeRunId = options.runId

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
        (parseError) =>
          new IntentDecodeFailure({
            message: `Intent event failed schema validation for correlationId=${input.correlationId}: ${parseError.message}`,
          }),
      )

    const decodeOutcome = (
      correlationId: string,
      payload: OutcomeInputPayload,
      recordedAt: string,
      protocolVersion: string,
    ) => {
      const record: Record<string, unknown> = {
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
        (parseError) =>
          new OutcomeDecodeFailure({
            message: `Outcome event failed schema validation for correlationId=${correlationId}: ${parseError.message}`,
          }),
      )
    }

    const recordIntent = (input: IntentInput): Effect.Effect<IntentAck, AgentBusFailure> =>
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
        return makeIntentAck(event.correlationId, event.recordedAt)
      })

    const recordOutcome = (
      ack: IntentAck,
      payload: OutcomeInputPayload,
    ): Effect.Effect<void, AgentBusFailure> =>
      Effect.gen(function* () {
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
      })

    const runWithIntent = <A, E, R>(
      intent: IntentInput,
      action: (ack: IntentAck) => Effect.Effect<A, E, R>,
      toOutcome: (result: A, ack: IntentAck) => OutcomeInputPayload,
    ): Effect.Effect<A, E | AgentBusFailure, R> =>
      // The action only runs after `recordIntent` succeeds — its input `ack` cannot exist until
      // the intent has been appended and confirmed by the sink. From that point on, we run inside
      // `uninterruptibleMask` so that even if the surrounding fiber is interrupted, the outcome
      // append is still attempted for the action that had already begun.
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ack = yield* recordIntent(intent)
          // `restore` re-enables interruption for the action itself, so callers can still cancel
          // it. `Effect.exit` reifies every terminal shape — success, typed failure, defect,
          // interrupt — into an inspectable Exit for classification.
          const actionExit = yield* Effect.exit(restore(action(ack)))
          const originalExitTag = classifyActionExit(actionExit)
          const outcomePayload = Exit.isSuccess(actionExit)
            ? toOutcome(actionExit.value, ack)
            : terminalOutcomeForFailure(
                ack,
                originalExitTag as 'TypedFailure' | 'Defect' | 'Interrupt',
              )
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
          // itself is never swallowed.
          const appendMessage = Cause.pretty(outcomeExit.cause)
          return yield* Effect.fail<AgentBusFailure>(
            new TerminalOutcomeAppendFailure({
              correlationId: ack.correlationId,
              originalActionExitTag: originalExitTag,
              appendFailureMessage: appendMessage,
            }),
          )
        }),
      )

    return {recordIntent, recordOutcome, runWithIntent}
  })
}

// ---------------------------------------------------------------------------------------------
// Test services
// ---------------------------------------------------------------------------------------------

/** Deterministic in-memory service. Uses Effect's Clock. No filesystem, no cross-test state. */
export const makeAgentBusTestService = (): Effect.Effect<AgentBusService> =>
  Effect.gen(function* () {
    const sink: CoreEventSink = {
      onIntent: () => Effect.void,
      onOutcome: () => Effect.void,
    }
    return yield* makeAgentBusFromSink(sink)
  })

export const AgentBusTestLayer = Layer.effect(AgentBusTag, makeAgentBusTestService())

/** In-memory service that also records every appended intent/outcome for inspection in tests. */
export interface RecordingAgentBus {
  readonly service: AgentBusService
  readonly intents: () => Effect.Effect<ReadonlyArray<IntentEvent>>
  readonly outcomes: () => Effect.Effect<ReadonlyArray<OutcomeEvent>>
}

export const makeRecordingAgentBus = (): Effect.Effect<RecordingAgentBus> =>
  Effect.gen(function* () {
    const intentsRef = yield* Ref.make<ReadonlyArray<IntentEvent>>([])
    const outcomesRef = yield* Ref.make<ReadonlyArray<OutcomeEvent>>([])
    const sink: CoreEventSink = {
      onIntent: (event) => Ref.update(intentsRef, (existing) => [...existing, event]),
      onOutcome: (event) => Ref.update(outcomesRef, (existing) => [...existing, event]),
    }
    const service = yield* makeAgentBusFromSink(sink)
    return {
      service,
      intents: () => Ref.get(intentsRef),
      outcomes: () => Ref.get(outcomesRef),
    }
  })

/**
 * In-memory service whose outcome-sink is instrumented to fail. Used by tests to prove that a
 * terminal outcome append failure is surfaced (never swallowed).
 */
export const makeFailingOutcomeAgentBus = (message: string): Effect.Effect<AgentBusService> =>
  Effect.gen(function* () {
    const sink: CoreEventSink = {
      onIntent: () => Effect.void,
      onOutcome: () =>
        Effect.fail(
          new AgentBusWriteFailure({message: `injected outcome sink failure: ${message}`}),
        ),
    }
    return yield* makeAgentBusFromSink(sink)
  })

// ---------------------------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------------------------

export interface AgentBusLiveOptions {
  /**
   * Explicit run id. If omitted, a fresh `crypto.randomUUID()` is minted per service instance so
   * that a fresh run never collides with any previous run's on-disk state.
   */
  readonly runId?: string
  /**
   * Optional runId of a prior run to resume. When supplied, the existing `{baseDir}/{skill}/
   * {personaId}/{runId}.jsonl` file for every persona directory under `{baseDir}/{skill}/` is
   * decoded and used to seed the in-memory correlation index — so replaying already-resolved
   * correlationIds fails with `DuplicateWithinRunFailure` instead of silently double-appending.
   * Torn or version-mismatched lines produce a typed `ResumeDecodeFailure`.
   *
   * NOTE: `resumeFromRunId` implies `runId = resumeFromRunId`. Passing both is a programmer error
   * and the two must agree — if they don't, the resume value wins.
   */
  readonly resumeFromRunId?: string
  /** Optional list of `${skill}/${personaId}` combinations to preload during resume. */
  readonly resumeScopes?: ReadonlyArray<{
    readonly skill: AgentBusSkill
    readonly personaId: string
  }>
}

async function readResumedStore(
  baseDir: string,
  runId: string,
  scopes: ReadonlyArray<{readonly skill: AgentBusSkill; readonly personaId: string}>,
): Promise<BusStore | ResumeDecodeFailure> {
  const correlations = new Map<string, CorrelationState>()
  for (const scope of scopes) {
    const file = path.join(baseDir, scope.skill, scope.personaId, `${runId}.jsonl`)
    let exists = false
    try {
      const info = await stat(file)
      exists = info.isFile()
    } catch {
      exists = false
    }
    if (!exists) continue
    const contents = await readFile(file, 'utf8')
    const lines = contents.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line || line.length === 0) continue
      const lineNumber = index + 1
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        return new ResumeDecodeFailure({
          runId,
          lineNumber,
          reason: 'invalid-json',
          message: `Line ${lineNumber} of ${file} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      }
      const decoded = Schema.decodeUnknownEither(WireEnvelopeSchema, {onExcessProperty: 'error'})(
        parsed,
      )
      if (Either.isLeft(decoded)) {
        const looksLikeVersion =
          typeof parsed === 'object' &&
          parsed !== null &&
          'protocolVersion' in parsed &&
          (parsed as Record<string, unknown>).protocolVersion !== AGENT_BUS_PROTOCOL_VERSION
        const reason = looksLikeVersion ? 'protocol-version-mismatch' : 'schema-mismatch'
        return new ResumeDecodeFailure({
          runId,
          lineNumber,
          reason,
          message: `[${reason}] Line ${lineNumber} of ${file} failed to decode: ${decoded.left.message}`,
        })
      }
      const envelope = decoded.right
      if (envelope.kind === 'intent') {
        const intentEvent: IntentEvent = {
          correlationId: envelope.correlationId,
          personaId: envelope.personaId,
          domain: envelope.domain,
          skill: envelope.skill,
          iteration: envelope.iteration,
          perceivedInterface: envelope.perceivedInterface,
          intendedAction: envelope.intendedAction,
          expectedResult: envelope.expectedResult,
          protocolVersion: envelope.protocolVersion,
          recordedAt: envelope.recordedAt,
        }
        correlations.set(envelope.correlationId, {intent: intentEvent, outcome: null})
      } else {
        const existing = correlations.get(envelope.correlationId)
        if (existing === undefined) {
          return new ResumeDecodeFailure({
            runId,
            lineNumber,
            reason: 'schema-mismatch',
            message: `Line ${lineNumber} of ${file} is an outcome without a preceding intent for correlationId=${envelope.correlationId}`,
          })
        }
        const outcomeEvent: OutcomeEvent = {
          correlationId: envelope.correlationId,
          actualResult: envelope.actualResult,
          delta: envelope.delta,
          desirability: envelope.desirability,
          degree: envelope.degree,
          observedFriction: envelope.observedFriction,
          protocolVersion: envelope.protocolVersion,
          recordedAt: envelope.recordedAt,
        }
        correlations.set(envelope.correlationId, {
          intent: existing.intent,
          outcome: outcomeEvent,
        })
      }
    }
  }
  return {correlations}
}

/**
 * Live service. Appends redacted JSONL lines to
 * `${baseDir}/${skill}/${personaId}/${runId}.jsonl`. Writes are serialized by a per-service
 * semaphore so concurrent `Effect.all` calls cannot interleave partial lines. Directory creation
 * is idempotent.
 *
 * `runId` isolates every fresh invocation of the bus from any prior on-disk state: the FRESH run
 * writes to a NEW file whose name is a UUID, so a re-run of the CLI never accidentally re-appends
 * to a previous run's log. `resumeFromRunId` opts into rejoining a prior run's file and rejects
 * duplicates within that run.
 */
export function makeAgentBusLiveService(
  baseDir: string = 'reports/agent-bus',
  options: AgentBusLiveOptions = {},
): Effect.Effect<AgentBusService, AgentBusWriteFailure | ResumeDecodeFailure> {
  return Effect.gen(function* () {
    const runId = options.resumeFromRunId ?? options.runId ?? randomUUID()
    let initialStore: BusStore = makeEmptyStore()
    if (options.resumeFromRunId !== undefined) {
      const scopes = options.resumeScopes ?? []
      const resumed = yield* Effect.tryPromise({
        try: () => readResumedStore(baseDir, options.resumeFromRunId!, scopes),
        catch: (error) =>
          new AgentBusWriteFailure({
            message: `Failed to read resume file: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }),
      })
      if (resumed instanceof ResumeDecodeFailure) {
        return yield* Effect.fail<ResumeDecodeFailure>(resumed)
      }
      initialStore = resumed
    }
    // A single mutex-style semaphore serializes all appends across the process, guaranteeing that
    // two concurrent iterations cannot produce a torn JSONL line.
    const writeMutex = yield* Effect.makeSemaphore(1)

    const writeLine = (
      skill: AgentBusSkill,
      personaId: string,
      line: string,
    ): Effect.Effect<void, AgentBusWriteFailure> =>
      writeMutex.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const dir = path.join(baseDir, skill, personaId)
            await mkdir(dir, {recursive: true})
            const file = path.join(dir, `${runId}.jsonl`)
            await appendFile(file, `${line}\n`, 'utf8')
          },
          catch: (error) =>
            new AgentBusWriteFailure({
              message: `Failed to append agent-bus event: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
        }),
      )

    const sink: CoreEventSink = {
      onIntent: (event) => {
        const redacted = redactIntentEvent(event)
        const payload = JSON.stringify({kind: 'intent', ...redacted})
        return writeLine(redacted.skill, redacted.personaId, payload)
      },
      onOutcome: (event, intent) => {
        // Route the outcome to the same file as its matching intent. The core bus guarantees
        // (via IntentMissingFailure) that we never reach this call without a recorded intent, so
        // `intent.skill` and `intent.personaId` are always the authoritative routing hints.
        const redacted = redactOutcomeEvent(event)
        const payload = JSON.stringify({kind: 'outcome', ...redacted})
        return writeLine(intent.skill, intent.personaId, payload)
      },
    }

    return yield* makeAgentBusFromSink(
      sink,
      options.resumeFromRunId !== undefined
        ? {initialStore, runId: options.resumeFromRunId}
        : {initialStore},
    )
  })
}

export function makeAgentBusLiveLayer(
  baseDir: string = 'reports/agent-bus',
  options: AgentBusLiveOptions = {},
) {
  return Layer.effect(AgentBusTag, makeAgentBusLiveService(baseDir, options))
}
