// Shared write-ahead persona bus.
//
// Purpose: prevent outcome-bias contamination when a persona (operator or contributor) records
// what it expected an interaction to do vs. what actually happened. Every observation must go
// through a two-phase intent → outcome ordering that is structurally enforced by the API surface,
// not merely by convention.
//
// Two phases:
//   1. `recordIntent` — the persona describes what interface it perceives, the action it intends,
//      and the result it expects. This MUST be appended and confirmed before any downstream action
//      runs. On success the caller receives an opaque `IntentAck` token.
//   2. `recordOutcome` — the persona reports the actual result, a delta description, and a bounded
//      desirability judgment. It requires the correlationId of a previously recorded intent, and
//      each correlationId may only be resolved once.
//
// `runWithIntent` is the critical anti-outcome-bias primitive. Because the action closure receives
// the `IntentAck` returned by `recordIntent`, and `IntentAck` is only produced when the intent has
// been successfully appended, it is a type error to run the action before the intent write
// succeeds. There is no way to fabricate an `IntentAck`, no method to mutate a recorded intent,
// and no method to delete an intent — the persona cannot fake a write-ahead after seeing the
// outcome, and cannot silently "update" its prediction to match reality.
//
// `degree` desirability anchors (also documented in AGENTS.md):
//   0.0 = fully undesirable / regression / friction moved the wrong way (or no meaningful change).
//   0.5 = mixed or neutral — some expected improvement, some regression, or ambiguous evidence.
//   1.0 = fully desirable — friction moved in the predicted direction to the predicted magnitude.

import {Clock, Context, Data, Effect, Either, Layer, Ref, Schema} from 'effect'
import {mkdir, appendFile} from 'node:fs/promises'
import path from 'node:path'

// Protocol version. Bump when the on-disk JSONL shape or a schema field changes in a way that a
// resumer cannot decode. The bus itself rejects any recorded event whose `protocolVersion` does
// not match the currently supported literal.
export const AGENT_BUS_PROTOCOL_VERSION = '1' as const

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

// Input shapes exclude the timestamp — the bus injects `recordedAt` so a caller cannot lie about
// when a prediction was made. `protocolVersion` is OPTIONAL on input: when omitted the bus
// injects the current version; when supplied it must match the current version or the bus
// rejects the write with `ProtocolVersionMismatchFailure`. This lets an offline replayer feed a
// serialized event through the same code path that a fresh caller uses.
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

export interface OutcomeInput {
  readonly correlationId: string
  readonly actualResult: string
  readonly delta: string
  readonly desirability: Desirability
  readonly degree: number
  readonly observedFriction?: string
  readonly protocolVersion?: string
}

export interface IntentAck {
  readonly correlationId: string
  readonly recordedAt: string
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

export type AgentBusFailure =
  | IntentDecodeFailure
  | OutcomeDecodeFailure
  | IntentMissingFailure
  | DuplicateIntentFailure
  | DuplicateOutcomeFailure
  | ProtocolVersionMismatchFailure
  | AgentBusWriteFailure

export interface AgentBusService {
  readonly recordIntent: (input: IntentInput) => Effect.Effect<IntentAck, AgentBusFailure>
  readonly recordOutcome: (input: OutcomeInput) => Effect.Effect<void, AgentBusFailure>
  readonly runWithIntent: <A, E, R>(
    intent: IntentInput,
    action: (ack: IntentAck) => Effect.Effect<A, E, R>,
    toOutcome: (result: A, ack: IntentAck) => OutcomeInput,
  ) => Effect.Effect<A, E | AgentBusFailure, R>
}

export class AgentBusTag extends Context.Tag('AgentBus')<AgentBusTag, AgentBusService>() {}

// Secret-shaped patterns. Conservative denylist — the goal is to make it impossible for a live
// event to leak an obvious credential shape. Matches are replaced with `[redacted]`.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // GitHub personal / app / OAuth / user-to-server tokens
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\bghs_[A-Za-z0-9]{20,}\b/g,
  /\bghr_[A-Za-z0-9]{20,}\b/g,
  // Azure DevOps PAT-like base64/alphanumeric >= 40 chars adjacent to "pat"
  /\b(pat|token|secret|password|apikey|api_key|bearer)\s*[:=]\s*['"]?[A-Za-z0-9._\-+/=]{16,}['"]?/gi,
  // AWS access key ids
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWT-ish (three base64url segments separated by dots)
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Generic Bearer <token>
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/g,
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
  const redacted: OutcomeEvent = {
    ...event,
    actualResult: redactSecrets(event.actualResult),
    delta: redactSecrets(event.delta),
    observedFriction:
      event.observedFriction === undefined ? undefined : redactSecrets(event.observedFriction),
  }
  return redacted
}

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

function makeAgentBusFromSink(sink: CoreEventSink): Effect.Effect<AgentBusService> {
  return Effect.gen(function* () {
    const stateRef = yield* Ref.make<BusStore>(makeEmptyStore())

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
            message: `Intent event failed schema validation: ${parseError.message}`,
          }),
      )

    const decodeOutcome = (input: OutcomeInput, recordedAt: string, protocolVersion: string) => {
      const payload: Record<string, unknown> = {
        correlationId: input.correlationId,
        actualResult: input.actualResult,
        delta: input.delta,
        desirability: input.desirability,
        degree: input.degree,
        protocolVersion,
        recordedAt,
      }
      if (input.observedFriction !== undefined) {
        payload.observedFriction = input.observedFriction
      }
      return Either.mapLeft(
        Schema.decodeUnknownEither(OutcomeEventSchema, {onExcessProperty: 'error'})(payload),
        (parseError) =>
          new OutcomeDecodeFailure({
            message: `Outcome event failed schema validation: ${parseError.message}`,
          }),
      )
    }

    const recordIntent = (input: IntentInput): Effect.Effect<IntentAck, AgentBusFailure> =>
      Effect.gen(function* () {
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
        return {correlationId: event.correlationId, recordedAt: event.recordedAt}
      })

    const recordOutcome = (input: OutcomeInput): Effect.Effect<void, AgentBusFailure> =>
      Effect.gen(function* () {
        const versionCheck = verifyProtocolVersion(input.protocolVersion)
        const protocolVersion = yield* Either.match(versionCheck, {
          onLeft: (failure) => Effect.fail<AgentBusFailure>(failure),
          onRight: (value) => Effect.succeed(value),
        })
        const recordedAt = yield* currentIsoInstant()
        const decoded = decodeOutcome(input, recordedAt, protocolVersion)
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
      toOutcome: (result: A, ack: IntentAck) => OutcomeInput,
    ): Effect.Effect<A, E | AgentBusFailure, R> =>
      Effect.gen(function* () {
        // The action only runs after `recordIntent` succeeds — its input `ack` cannot exist until
        // the intent has been appended and confirmed by the sink. There is no path in this
        // function that lets `action` observe intent-failure and still execute.
        const ack = yield* recordIntent(intent)
        const result = yield* action(ack)
        yield* recordOutcome(toOutcome(result, ack))
        return result
      })

    return {recordIntent, recordOutcome, runWithIntent}
  })
}

// Deterministic in-memory test service. Uses Effect's Clock so tests can inject a TestClock for
// non-flaky timestamps. No filesystem, no wall-clock, no cross-test state.
export const makeAgentBusTestService = (): Effect.Effect<AgentBusService> =>
  Effect.gen(function* () {
    const sink: CoreEventSink = {
      onIntent: () => Effect.void,
      onOutcome: () => Effect.void,
    }
    return yield* makeAgentBusFromSink(sink)
  })

export const AgentBusTestLayer = Layer.effect(AgentBusTag, makeAgentBusTestService())

/**
 * In-memory `AgentBusService` builder for tests that want to inspect what was written.
 */
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
      onOutcome: (event, _intent) => Ref.update(outcomesRef, (existing) => [...existing, event]),
    }
    const service = yield* makeAgentBusFromSink(sink)
    return {
      service,
      intents: () => Ref.get(intentsRef),
      outcomes: () => Ref.get(outcomesRef),
    }
  })

/**
 * Live layer effect. Appends redacted JSONL lines to
 * `${baseDir}/${skill}/${personaId}.jsonl`. Writes are serialized by a per-service semaphore so
 * concurrent `Effect.all` calls cannot interleave partial lines. Directory creation is idempotent.
 */
export function makeAgentBusLiveService(
  baseDir: string = 'reports/agent-bus',
): Effect.Effect<AgentBusService> {
  return Effect.gen(function* () {
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
            const dir = path.join(baseDir, skill)
            await mkdir(dir, {recursive: true})
            const file = path.join(dir, `${personaId}.jsonl`)
            await appendFile(file, `${line}\n`, 'utf8')
          },
          catch: (error) =>
            new AgentBusWriteFailure({
              message: `Failed to append agent-bus event: ${error instanceof Error ? error.message : String(error)}`,
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
        // (via IntentMissingFailure) that we never reach this call without a recorded intent,
        // so `intent.skill` and `intent.personaId` are always the authoritative routing hints.
        const redacted = redactOutcomeEvent(event)
        const payload = JSON.stringify({kind: 'outcome', ...redacted})
        return writeLine(intent.skill, intent.personaId, payload)
      },
    }

    return yield* makeAgentBusFromSink(sink)
  })
}

export function makeAgentBusLiveLayer(baseDir: string = 'reports/agent-bus') {
  return Layer.effect(AgentBusTag, makeAgentBusLiveService(baseDir))
}
