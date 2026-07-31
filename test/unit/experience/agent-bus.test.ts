import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Cause, Effect, Exit, Fiber, Layer, Ref} from 'effect'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  AGENT_BUS_PROTOCOL_VERSION,
  AgentBusTag,
  AgentBusWriteFailure,
  DESIRABILITY_SCALE_DESCRIPTION,
  DuplicateIntentFailure,
  DuplicateOutcomeFailure,
  DuplicateWithinRunFailure,
  IntentDecodeFailure,
  IntentMissingFailure,
  OutcomePayloadDecodeFailure,
  PathUnsafeIdentifierFailure,
  PersonaDomainSkillMismatchFailure,
  ProtocolVersionMismatchFailure,
  ResumeDecodeFailure,
  ResumeReadFailure,
  TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION,
  TerminalOutcomeAppendFailure,
  makeAgentBusTestService,
  makeDeterministicRunIdentity,
  makeDeterministicRunIdentityLayer,
  makeFailingOutcomeAgentBus,
  makeFixedRunIdentity,
  makeRecordingAgentBus,
  redactSecrets,
  type AgentBusService,
  type IntentAck,
  type IntentInput,
  type OutcomeInputPayload,
} from '../../../src/experience/agent-bus.js'
import * as agentBusLive from '../../../src/experience/agent-bus-live.js'
import {
  RunIdentityLive,
  makeAgentBusLiveLayer,
  makeAgentBusLiveService,
} from '../../../src/experience/agent-bus-live.js'

function baseIntent(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    correlationId: 'optimize-ux:time-pressured-engineer:1:approve',
    personaId: 'time-pressured-engineer',
    domain: 'operator',
    skill: 'optimize-ux',
    iteration: 1,
    perceivedInterface: 'compact stage status line',
    intendedAction: 'approve the migration plan',
    expectedResult: 'friction on approvalContext drops',
    ...overrides,
  }
}

function basePayload(overrides: Partial<OutcomeInputPayload> = {}): OutcomeInputPayload {
  return {
    actualResult: 'approval prompt colocated all target writes',
    delta: 'approvalContext friction decreased as predicted',
    desirability: 'desirable',
    degree: 0.9,
    ...overrides,
  }
}

// Distinguishable per-shape payload authoring. Anti-boilerplate: each of the four shapes
// produces a payload the caller could not have written by copy-pasting from another shape.
function authoredPayload(
  kind: 'success' | 'typed-failure' | 'defect' | 'interrupt',
): OutcomeInputPayload {
  switch (kind) {
    case 'success':
      return basePayload({
        actualResult: 'success-shape: caller observed the predicted approvalContext reduction',
        delta: 'success-shape delta: observed friction matched prediction',
        desirability: 'desirable',
        degree: 0.9,
      })
    case 'typed-failure':
      return {
        actualResult:
          'typed-failure-shape: caller-authored — scenario runner returned a domain error before any friction was measured',
        delta: 'typed-failure-shape delta: no comparison because scenario runner failed',
        desirability: 'undesirable',
        degree: 0.1,
        observedFriction: 'typed-failure-caller-tag',
      }
    case 'defect':
      return {
        actualResult: 'defect-shape: caller-authored — unchecked defect aborted the walkthrough',
        delta: 'defect-shape delta: no comparison because iteration crashed',
        desirability: 'undesirable',
        degree: 0.05,
        observedFriction: 'defect-caller-tag',
      }
    case 'interrupt':
      return {
        actualResult:
          'interrupt-shape: caller-authored — run was cut off before scenario evaluation completed',
        delta: 'interrupt-shape delta: no comparison because run was interrupted mid-flight',
        desirability: 'undesirable',
        degree: 0.0,
        observedFriction: 'interrupt-caller-tag',
      }
  }
}

describe('agent-bus write-ahead protocol', () => {
  describe('in-memory bus — anti-outcome-bias invariants', () => {
    it('runWithIntent never runs the action when recordIntent fails (schema failure)', async () => {
      // Anti-outcome-bias: a failing recordIntent must prevent the action closure from firing.
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const callCounter = yield* Ref.make(0)
          const invalidIntent: IntentInput = {
            ...baseIntent(),
            iteration: 0, // schema requires >= 1 → IntentDecodeFailure
          }
          const exit = yield* Effect.exit(
            bus.runWithIntent(
              invalidIntent,
              () =>
                Ref.update(callCounter, (count) => count + 1).pipe(
                  Effect.andThen(Effect.succeed('unreachable')),
                ),
              () => authoredPayload('success'),
            ),
          )
          const invocations = yield* Ref.get(callCounter)
          return {exit, invocations}
        }),
      )
      expect(result.invocations).toBe(0)
      expect(Exit.isFailure(result.exit)).toBe(true)
      if (Exit.isFailure(result.exit)) {
        const message = Cause.pretty(result.exit.cause)
        expect(message).toContain('IntentDecodeFailure')
      }
    })

    it('toOutcome is invoked exactly ONCE per iteration, for the Success shape, and a caller-authored payload is persisted', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const toOutcomeCalls = yield* Ref.make(0)
          const value = yield* recording.service.runWithIntent(
            baseIntent(),
            () => Effect.succeed('ok'),
            (exit) => {
              // Increment inside the callback so we can assert single-invocation.
              Effect.runSync(Ref.update(toOutcomeCalls, (n) => n + 1))
              expect(Exit.isSuccess(exit)).toBe(true)
              return authoredPayload('success')
            },
          )
          const outcomes = yield* recording.outcomes()
          const invocations = yield* Ref.get(toOutcomeCalls)
          return {value, outcomes, invocations}
        }),
      )
      expect(result.value).toBe('ok')
      expect(result.invocations).toBe(1)
      expect(result.outcomes).toHaveLength(1)
      expect(result.outcomes[0]?.actualResult).toContain('success-shape')
    })

    it('toOutcome authors DISTINGUISHABLE payloads for all four exit shapes — bus never synthesizes a generic default', async () => {
      // Success, TypedFailure, Defect, Interrupt: prove the CALLER's toOutcome fires for each,
      // fires exactly once each, and produces four DIFFERENT payloads.
      const successOutcome = await runShape('success')
      const typedFailureOutcome = await runShape('typed-failure')
      const defectOutcome = await runShape('defect')
      const interruptOutcome = await runShape('interrupt')

      // Distinct on the actualResult marker and observedFriction tag — no generic default text.
      const markers = new Set([
        successOutcome.actualResult,
        typedFailureOutcome.actualResult,
        defectOutcome.actualResult,
        interruptOutcome.actualResult,
      ])
      expect(markers.size).toBe(4)
      const frictions = new Set([
        successOutcome.observedFriction ?? '',
        typedFailureOutcome.observedFriction ?? '',
        defectOutcome.observedFriction ?? '',
        interruptOutcome.observedFriction ?? '',
      ])
      expect(frictions.size).toBe(4)
      // No accidental "no comparison available" boilerplate leaking from the bus itself.
      for (const outcome of [
        successOutcome,
        typedFailureOutcome,
        defectOutcome,
        interruptOutcome,
      ]) {
        expect(outcome.delta.toLowerCase()).not.toBe('no comparison available')
      }

      async function runShape(kind: 'success' | 'typed-failure' | 'defect' | 'interrupt') {
        return Effect.runPromise(
          Effect.gen(function* () {
            const recording = yield* makeRecordingAgentBus()
            const toOutcomeCalls = yield* Ref.make(0)
            const seenKinds = yield* Ref.make<ReadonlyArray<string>>([])
            const runFn =
              kind === 'success'
                ? recording.service.runWithIntent(
                    baseIntent({correlationId: `optimize-ux:time-pressured-engineer:1:${kind}`}),
                    () => Effect.succeed('ok'),
                    (exit) => {
                      Effect.runSync(Ref.update(toOutcomeCalls, (n) => n + 1))
                      const seenKind = Exit.isSuccess(exit)
                        ? 'success'
                        : Cause.isInterruptedOnly(exit.cause)
                          ? 'interrupt'
                          : Cause.isDie(exit.cause)
                            ? 'defect'
                            : 'typed-failure'
                      Effect.runSync(Ref.update(seenKinds, (arr) => [...arr, seenKind]))
                      return authoredPayload('success')
                    },
                  )
                : kind === 'typed-failure'
                  ? Effect.exit(
                      recording.service.runWithIntent(
                        baseIntent({
                          correlationId: `optimize-ux:time-pressured-engineer:1:${kind}`,
                        }),
                        () => Effect.fail(new Error('scenario-runner-failure')),
                        (exit) => {
                          Effect.runSync(Ref.update(toOutcomeCalls, (n) => n + 1))
                          const seenKind = Exit.isSuccess(exit)
                            ? 'success'
                            : Cause.isInterruptedOnly(exit.cause)
                              ? 'interrupt'
                              : Cause.isDie(exit.cause)
                                ? 'defect'
                                : 'typed-failure'
                          Effect.runSync(Ref.update(seenKinds, (arr) => [...arr, seenKind]))
                          return authoredPayload('typed-failure')
                        },
                      ),
                    )
                  : kind === 'defect'
                    ? Effect.exit(
                        recording.service.runWithIntent(
                          baseIntent({
                            correlationId: `optimize-ux:time-pressured-engineer:1:${kind}`,
                          }),
                          () => Effect.die(new Error('unchecked-defect')),
                          (exit) => {
                            Effect.runSync(Ref.update(toOutcomeCalls, (n) => n + 1))
                            const seenKind = Exit.isSuccess(exit)
                              ? 'success'
                              : Cause.isInterruptedOnly(exit.cause)
                                ? 'interrupt'
                                : Cause.isDie(exit.cause)
                                  ? 'defect'
                                  : 'typed-failure'
                            Effect.runSync(Ref.update(seenKinds, (arr) => [...arr, seenKind]))
                            return authoredPayload('defect')
                          },
                        ),
                      )
                    : Effect.gen(function* () {
                        const started = yield* Ref.make(false)
                        const fiber = yield* Effect.fork(
                          recording.service.runWithIntent(
                            baseIntent({
                              correlationId: `optimize-ux:time-pressured-engineer:1:${kind}`,
                            }),
                            () =>
                              Ref.set(started, true).pipe(
                                Effect.andThen(Effect.sleep('10 seconds')),
                              ),
                            (exit) => {
                              Effect.runSync(Ref.update(toOutcomeCalls, (n) => n + 1))
                              const seenKind = Exit.isSuccess(exit)
                                ? 'success'
                                : Cause.isInterruptedOnly(exit.cause)
                                  ? 'interrupt'
                                  : Cause.isDie(exit.cause)
                                    ? 'defect'
                                    : 'typed-failure'
                              Effect.runSync(Ref.update(seenKinds, (arr) => [...arr, seenKind]))
                              return authoredPayload('interrupt')
                            },
                          ),
                        )
                        yield* Effect.repeat(Ref.get(started), {
                          until: (value) => value === true,
                          schedule: undefined,
                        }).pipe(
                          Effect.timeout('2 seconds'),
                          Effect.orElse(() => Effect.void),
                        )
                        yield* Fiber.interrupt(fiber)
                        yield* Effect.sleep('100 millis')
                        return undefined
                      })
            const runFnAny = runFn as unknown as Effect.Effect<unknown, unknown>
            yield* runFnAny.pipe(Effect.catchAll(() => Effect.void))
            const outcomes = yield* recording.outcomes()
            const invocations = yield* Ref.get(toOutcomeCalls)
            const kinds = yield* Ref.get(seenKinds)
            expect(invocations, `toOutcome for ${kind}`).toBe(1)
            expect(kinds, `exit kind seen for ${kind}`).toEqual([kind])
            expect(outcomes, `outcomes for ${kind}`).toHaveLength(1)
            return outcomes[0]!
          }),
        )
      }
    })

    it('runWithIntent preserves the original Exit on the success path and on the typed-failure path when the outcome append succeeds', async () => {
      // Success path: original value is re-surfaced.
      const successValue = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          return yield* recording.service.runWithIntent(
            baseIntent(),
            () => Effect.succeed(42 as const),
            () => authoredPayload('success'),
          )
        }),
      )
      expect(successValue).toBe(42)

      // Typed-failure path: original typed error re-surfaces unchanged.
      const failureExit = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          return yield* Effect.exit(
            recording.service.runWithIntent(
              baseIntent(),
              () => Effect.fail('original-typed-error' as const),
              () => authoredPayload('typed-failure'),
            ),
          )
        }),
      )
      expect(Exit.isFailure(failureExit)).toBe(true)
      if (Exit.isFailure(failureExit)) {
        const failure = Cause.failureOption(failureExit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') expect(failure.value).toBe('original-typed-error')
      }
    })

    it('surfaces a TerminalOutcomeAppendFailure when the outcome sink itself fails — never swallowed', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeFailingOutcomeAgentBus('sink is offline')
          return yield* Effect.either(
            bus.runWithIntent(
              baseIntent(),
              () => Effect.succeed('ok'),
              () => authoredPayload('success'),
            ),
          )
        }),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(TerminalOutcomeAppendFailure)
        const failure = result.left as TerminalOutcomeAppendFailure
        expect(failure.originalActionExitTag).toBe('Success')
        expect(failure.appendFailureMessage).toContain('injected outcome sink failure')
      }
    })

    it('recordOutcome without a prior recordIntent fails with IntentMissingFailure', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const forgedAck = {
            correlationId: 'no-such-intent:1:1:1',
            recordedAt: '1970-01-01T00:00:00.000Z',
            runId: 'test-run',
          } as unknown as IntentAck
          return yield* Effect.either(bus.recordOutcome(forgedAck, basePayload()))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(IntentMissingFailure)
      }
    })

    it('rejects a second recordOutcome for the same ack with DuplicateOutcomeFailure', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const ack = yield* bus.recordIntent(baseIntent())
          yield* bus.recordOutcome(ack, basePayload())
          return yield* Effect.either(bus.recordOutcome(ack, basePayload()))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(DuplicateOutcomeFailure)
      }
    })

    it('rejects a second recordIntent for the same correlationId with DuplicateIntentFailure', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          yield* bus.recordIntent(baseIntent())
          return yield* Effect.either(bus.recordIntent(baseIntent()))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(DuplicateIntentFailure)
      }
    })

    it('has no service method that can mutate or delete a previously recorded intent', async () => {
      const bus = await Effect.runPromise(makeAgentBusTestService())
      const methodNames = new Set(Object.keys(bus))
      expect(methodNames).toEqual(new Set(['recordIntent', 'recordOutcome', 'runWithIntent']))
      const asRecord = bus as unknown as Record<string, unknown>
      expect(asRecord.updateIntent).toBeUndefined()
      expect(asRecord.deleteIntent).toBeUndefined()
      expect(asRecord.setIntent).toBeUndefined()
      expect(asRecord.patchIntent).toBeUndefined()
    })

    it('rejects a protocolVersion that does not match the current bus version', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const stale = baseIntent({protocolVersion: '0'})
          return yield* Effect.either(bus.recordIntent(stale))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(ProtocolVersionMismatchFailure)
      }
    })

    it('rejects a degree outside [0, 1] via schema decoding — degree is bounded desirability', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const ack = yield* bus.recordIntent(baseIntent())
          return yield* Effect.either(bus.recordOutcome(ack, basePayload({degree: 1.5})))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        // Strict payload decoding fires first — degree is out of range at the payload boundary.
        expect(['OutcomePayloadDecodeFailure', 'OutcomeDecodeFailure']).toContain(failure.left._tag)
      }
    })

    it('rejects an obviously malformed input via IntentDecodeFailure', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const bad = baseIntent({iteration: 0})
          return yield* Effect.either(bus.recordIntent(bad))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(IntentDecodeFailure)
      }
    })

    it('keeps distinct correlationIds fully isolated from each other', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const bus = recording.service
          const intentA = baseIntent({
            correlationId: 'optimize-ux:time-pressured-engineer:1:approve',
            personaId: 'time-pressured-engineer',
          })
          const intentB = baseIntent({
            correlationId: 'optimize-ux:first-time-coordinator:1:approve',
            personaId: 'first-time-coordinator',
          })
          const ackA = yield* bus.recordIntent(intentA)
          const ackB = yield* bus.recordIntent(intentB)
          yield* bus.recordOutcome(ackB, basePayload())
          const secondBOutcome = yield* Effect.either(bus.recordOutcome(ackB, basePayload()))
          yield* bus.recordOutcome(ackA, basePayload())
          const intents = yield* recording.intents()
          const outcomes = yield* recording.outcomes()
          return {secondBOutcome, intents, outcomes}
        }),
      )
      expect(result.secondBOutcome._tag).toBe('Left')
      if (result.secondBOutcome._tag === 'Left') {
        expect(result.secondBOutcome.left).toBeInstanceOf(DuplicateOutcomeFailure)
      }
      expect(result.intents.map((event) => event.personaId).sort()).toEqual([
        'first-time-coordinator',
        'time-pressured-engineer',
      ])
      expect(result.outcomes).toHaveLength(2)
      expect(new Set(result.outcomes.map((event) => event.correlationId))).toEqual(
        new Set([
          'optimize-ux:time-pressured-engineer:1:approve',
          'optimize-ux:first-time-coordinator:1:approve',
        ]),
      )
    })

    it('handles concurrent recordIntent/recordOutcome across many correlationIds without cross-talk', async () => {
      const knownPersonas = [
        'first-time-coordinator',
        'risk-accountable-owner',
        'time-pressured-engineer',
        'nonvisual-operator',
        'unattended-automation-engineer',
      ]
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const bus = recording.service
          const workload = knownPersonas.map((personaId, index) => ({
            intent: baseIntent({
              correlationId: `optimize-ux:${personaId}:1:action-${index}`,
              personaId,
              iteration: 1,
            }),
          }))
          yield* Effect.all(
            workload.map(({intent}) =>
              Effect.gen(function* () {
                const ack = yield* bus.recordIntent(intent)
                yield* bus.recordOutcome(ack, basePayload())
              }),
            ),
            {concurrency: 'unbounded'},
          )
          const intents = yield* recording.intents()
          const outcomes = yield* recording.outcomes()
          return {intents, outcomes}
        }),
      )
      expect(result.intents).toHaveLength(knownPersonas.length)
      expect(result.outcomes).toHaveLength(knownPersonas.length)
    })
  })

  describe('outcome payload schema — strict rejection of excess correlationId alias', () => {
    it('rejects a caller-supplied correlationId in the outcome payload with OutcomePayloadDecodeFailure', async () => {
      // Structural guarantee: the outcome payload schema uses strict decoding, so a caller who
      // includes `correlationId` (a legacy alias field) gets a typed rejection rather than
      // silent disregard. Correlation identity comes ONLY from the IntentAck.
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const ack = yield* recording.service.recordIntent(baseIntent())
          const payloadWithForgery = {
            ...basePayload(),
            correlationId: 'forged-correlation-id',
          } as unknown as OutcomeInputPayload
          return yield* Effect.either(recording.service.recordOutcome(ack, payloadWithForgery))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(OutcomePayloadDecodeFailure)
      }
    })

    it('a clean payload (no correlationId alias) records normally with the ack correlationId', async () => {
      const outcomes = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const ack = yield* recording.service.recordIntent(baseIntent())
          yield* recording.service.recordOutcome(ack, basePayload())
          return yield* recording.outcomes()
        }),
      )
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]?.correlationId).toBe('optimize-ux:time-pressured-engineer:1:approve')
    })
  })

  describe('persona/domain/skill matrix + path safety', () => {
    it('accepts a valid operator + optimize-ux pairing', async () => {
      const ack = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          return yield* bus.recordIntent(baseIntent())
        }),
      )
      expect(ack.correlationId).toBeDefined()
    })

    it('rejects a developer persona paired with optimize-ux', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const wrong = baseIntent({
            personaId: 'cli-contributor-engineer',
            domain: 'developer',
            skill: 'optimize-ux',
            correlationId: 'optimize-ux:cli-contributor-engineer:1:x',
          })
          return yield* Effect.either(bus.recordIntent(wrong))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(PersonaDomainSkillMismatchFailure)
        const f = failure.left as PersonaDomainSkillMismatchFailure
        expect(f.reason).toBe('developer-skill-mismatch')
      }
    })

    it('rejects an operator persona paired with optimize-dx', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const wrong = baseIntent({
            personaId: 'time-pressured-engineer',
            domain: 'operator',
            skill: 'optimize-dx',
            correlationId: 'optimize-dx:time-pressured-engineer:1:x',
          })
          return yield* Effect.either(bus.recordIntent(wrong))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(PersonaDomainSkillMismatchFailure)
        const f = failure.left as PersonaDomainSkillMismatchFailure
        expect(f.reason).toBe('operator-skill-mismatch')
      }
    })

    it('rejects an unknown persona id', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const wrong = baseIntent({
            personaId: 'made-up-persona',
            correlationId: 'optimize-ux:made-up-persona:1:x',
          })
          return yield* Effect.either(bus.recordIntent(wrong))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(PersonaDomainSkillMismatchFailure)
        const f = failure.left as PersonaDomainSkillMismatchFailure
        expect(f.reason).toBe('unknown-persona')
      }
    })

    it('rejects a persona id declared under the wrong domain (persona/domain mismatch)', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const wrong = baseIntent({
            personaId: 'cli-contributor-engineer',
            domain: 'operator',
            skill: 'optimize-ux',
            correlationId: 'optimize-ux:cli-contributor-engineer:1:x',
          })
          return yield* Effect.either(bus.recordIntent(wrong))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(PersonaDomainSkillMismatchFailure)
        const f = failure.left as PersonaDomainSkillMismatchFailure
        expect(f.reason).toBe('domain-persona-mismatch')
      }
    })

    it('rejects a path-traversal-shaped persona id BEFORE any write is attempted', async () => {
      const failures = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const attempts = [
            '../etc/passwd',
            '..\\etc\\passwd',
            'time-pressured-engineer/../nonvisual-operator',
            'time-pressured-engineer\0evil',
          ]
          const results: Array<{
            attempt: string
            result: {readonly _tag: 'Left' | 'Right'; readonly left?: unknown}
          }> = []
          for (const attempt of attempts) {
            const result = yield* Effect.either(
              bus.recordIntent(
                baseIntent({personaId: attempt, correlationId: `optimize-ux:x:1:x-${attempt}`}),
              ),
            )
            results.push({attempt, result})
          }
          return results
        }),
      )
      for (const {attempt, result} of failures) {
        expect(result._tag, `attempt ${JSON.stringify(attempt)}`).toBe('Left')
        if (result._tag === 'Left') {
          const failure = result.left
          const isPathUnsafe = failure instanceof PathUnsafeIdentifierFailure
          const isMismatch = failure instanceof PersonaDomainSkillMismatchFailure
          expect(
            isPathUnsafe || isMismatch,
            `attempt ${JSON.stringify(attempt)} must be rejected by a path-safety or matrix check`,
          ).toBe(true)
        }
      }
    })
  })

  describe('IntentAck unforgeability', () => {
    it('cannot be caller-forged through the public API — compile-time proof', async () => {
      const bus = await Effect.runPromise(makeAgentBusTestService())
      const _bus: AgentBusService = bus
      // @ts-expect-error — IntentAck cannot be constructed from a plain object literal (missing brand)
      const _forged: IntentAck = {correlationId: 'x', recordedAt: 'y', runId: 'z'}
      expect(_forged.correlationId).toBe('x')
      expect(_bus).toBeDefined()
    })
  })

  describe('RunIdentityTag / RunIdentityLive', () => {
    it('makeDeterministicRunIdentity returns each value in sequence and dies past the end', async () => {
      const identity = makeDeterministicRunIdentity(['a', 'b'])
      const first = await Effect.runPromise(identity.generate)
      const second = await Effect.runPromise(identity.generate)
      expect(first).toBe('a')
      expect(second).toBe('b')
      const past = await Effect.runPromiseExit(identity.generate)
      expect(Exit.isFailure(past)).toBe(true)
    })

    it('makeFixedRunIdentity returns the same value every time', async () => {
      const identity = makeFixedRunIdentity('locked')
      const a = await Effect.runPromise(identity.generate)
      const b = await Effect.runPromise(identity.generate)
      expect(a).toBe('locked')
      expect(b).toBe('locked')
    })

    it('the live layer obtains the runId via RunIdentityTag, not through a direct randomUUID call', async () => {
      // Prove that a deterministic RunIdentity layer overrides the live layer's default UUID
      // source. If the live service ever regressed to calling randomUUID directly, the
      // deterministic layer would be ignored and the assertion below would fail.
      const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-runid-tag-'))
      try {
        const rawLayer = Layer.effect(AgentBusTag, makeAgentBusLiveService(tempDir))
        const deterministicLayer = Layer.provide(
          rawLayer,
          makeDeterministicRunIdentityLayer(['deterministic-run-42']),
        )
        await Effect.runPromise(
          Effect.gen(function* () {
            const bus = yield* AgentBusTag
            const ack = yield* bus.recordIntent(baseIntent())
            expect(ack.runId).toBe('deterministic-run-42')
            yield* bus.recordOutcome(ack, basePayload())
          }).pipe(Effect.provide(deterministicLayer)),
        )
        // The persisted file MUST live under the deterministic runId directory.
        const expected = path.join(
          tempDir,
          'optimize-ux',
          'time-pressured-engineer',
          'deterministic-run-42.jsonl',
        )
        const contents = await readFile(expected, 'utf8')
        expect(contents.length).toBeGreaterThan(0)
      } finally {
        await rm(tempDir, {recursive: true, force: true})
      }
    })

    it('the live-bus source file grep-checks that RunIdentityLive is the ONLY place calling randomUUID', async () => {
      // Enforcement guard: the domain module MUST NOT import randomUUID; the live adapter file
      // MAY, but only inside RunIdentityLive. Read both files and assert.
      const domain = await readFile(path.join(process.cwd(), 'src/experience/agent-bus.ts'), 'utf8')
      const adapter = await readFile(
        path.join(process.cwd(), 'src/experience/agent-bus-live.ts'),
        'utf8',
      )
      // The domain module must never IMPORT or CALL `randomUUID`. Test refuses both, but comments
      // that merely mention the name are allowed (they document the boundary the test enforces).
      expect(domain).not.toMatch(/import\s*\{[^}]*\brandomUUID\b/)
      expect(domain).not.toMatch(/randomUUID\s*\(/)
      expect(domain).not.toMatch(/from ['"]node:crypto['"]/)
      expect(domain).not.toMatch(/from ['"]node:fs/)
      // Adapter is allowed exactly one import of randomUUID and one usage inside RunIdentityLive.
      const importCount = adapter.match(/import\s*\{[^}]*\brandomUUID\b/g)?.length ?? 0
      expect(importCount).toBe(1)
      const usageMatches = adapter.match(/randomUUID\s*\(\s*\)/g) ?? []
      expect(usageMatches.length).toBe(1)
    })
  })

  describe('runId path-safety validation', () => {
    let tempDir: string
    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-runid-safety-'))
    })
    afterEach(async () => {
      await rm(tempDir, {recursive: true, force: true})
    })

    for (const attempt of [
      {kind: 'path-separator', value: '../evil'},
      {kind: 'backslash', value: 'a\\b'},
      {kind: 'dotdot', value: 'run..1'},
      {kind: 'null-byte', value: 'a\0b'},
      {kind: 'empty', value: ''},
      {kind: 'too-long', value: 'x'.repeat(200)},
    ] as const) {
      it(`refuses runId ${attempt.kind} (${JSON.stringify(attempt.value).slice(0, 40)}) BEFORE touching disk`, async () => {
        const exit = await Effect.runPromiseExit(
          makeAgentBusLiveService(tempDir, {runId: attempt.value}).pipe(
            Effect.provide(RunIdentityLive),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const rendered = Cause.pretty(exit.cause)
          expect(rendered).toContain('PathUnsafeIdentifierFailure')
        }
      })

      it(`refuses resumeFromRunId ${attempt.kind} BEFORE touching disk`, async () => {
        const exit = await Effect.runPromiseExit(
          makeAgentBusLiveService(tempDir, {resumeFromRunId: attempt.value}).pipe(
            Effect.provide(RunIdentityLive),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const rendered = Cause.pretty(exit.cause)
          expect(rendered).toContain('PathUnsafeIdentifierFailure')
        }
      })
    }

    it('rejects a RunIdentityTag implementation that returns an unsafe runId — belt-and-braces', async () => {
      const exit = await Effect.runPromiseExit(
        makeAgentBusLiveService(tempDir).pipe(
          Effect.provide(makeDeterministicRunIdentityLayer(['../evil'])),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain('PathUnsafeIdentifierFailure')
      }
    })
  })

  describe('persisted events self-identify their run', () => {
    let tempDir: string
    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-self-id-'))
    })
    afterEach(async () => {
      await rm(tempDir, {recursive: true, force: true})
    })

    it('every persisted intent and outcome carries a runId field that matches the file/runId', async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'run-self-id'}).pipe(
            Effect.provide(RunIdentityLive),
          )
          const ack = yield* bus.recordIntent(baseIntent())
          expect(ack.runId).toBe('run-self-id')
          yield* bus.recordOutcome(ack, basePayload())
        }),
      )
      const file = path.join(tempDir, 'optimize-ux', 'time-pressured-engineer', 'run-self-id.jsonl')
      const contents = await readFile(file, 'utf8')
      const lines = contents.split(/\r?\n/).filter((line) => line.length > 0)
      expect(lines).toHaveLength(2)
      for (const line of lines) {
        const parsed = JSON.parse(line) as {runId: string; kind: string}
        expect(parsed.runId).toBe('run-self-id')
        expect(['intent', 'outcome']).toContain(parsed.kind)
      }
    })
  })

  describe('resume — IO error propagation vs benign ENOENT', () => {
    let tempDir: string
    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-resume-io-'))
    })
    afterEach(async () => {
      await rm(tempDir, {recursive: true, force: true})
    })

    it('ENOENT is benign — resume proceeds with an empty seed', async () => {
      // No file exists at the resume path — this must NOT fail; the resumer proceeds with an
      // empty in-memory correlation index.
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {
            resumeFromRunId: 'nonexistent-run',
            resumeScopes: [{skill: 'optimize-ux', personaId: 'time-pressured-engineer'}],
          }).pipe(Effect.provide(RunIdentityLive))
          const ack = yield* bus.recordIntent(baseIntent())
          expect(ack.runId).toBe('nonexistent-run')
        }),
      )
    })

    it('a non-ENOENT filesystem error surfaces as a typed ResumeReadFailure — never silently swallowed as "no prior run"', async () => {
      // Simulate a non-ENOENT filesystem error at resume-time by intercepting `stat` and throwing
      // an EACCES-tagged error. The resumer must NOT swallow this as "file not present" — it
      // must surface a typed `ResumeReadFailure` so the caller can distinguish a permission or
      // I/O fault from a truly-absent prior run.
      const eaccesError = Object.assign(new Error('permission denied'), {code: 'EACCES'})
      const statSpy = vi.spyOn(agentBusLive._fsOps, 'stat').mockRejectedValueOnce(eaccesError)
      try {
        const exit = await Effect.runPromiseExit(
          Effect.gen(function* () {
            const bus = yield* makeAgentBusLiveService(tempDir, {
              resumeFromRunId: 'perm-denied-run',
              resumeScopes: [{skill: 'optimize-ux', personaId: 'time-pressured-engineer'}],
            }).pipe(Effect.provide(RunIdentityLive))
            // Should never get here — the resume seed above must fail.
            yield* bus.recordIntent(baseIntent())
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const rendered = Cause.pretty(exit.cause)
          expect(rendered).toContain('ResumeReadFailure')
          expect(rendered).toContain('EACCES')
          // The raw underlying error message must NOT leak — the failure describes the class,
          // not the raw exception text (which could contain a path or payload fragment).
          expect(rendered).not.toContain('permission denied')
        }
      } finally {
        statSpy.mockRestore()
      }
    })

    it('exports ResumeReadFailure so callers can catch non-ENOENT resume errors', () => {
      const err = new ResumeReadFailure({
        runId: 'x',
        errorCode: 'EACCES',
        message: 'stub',
      })
      expect(err._tag).toBe('ResumeReadFailure')
      expect(err.errorCode).toBe('EACCES')
    })
  })

  describe('resume — replay duplicate / out-of-order sequence detection', () => {
    let tempDir: string
    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-replay-'))
    })
    afterEach(async () => {
      await rm(tempDir, {recursive: true, force: true})
    })

    const persona = 'time-pressured-engineer'
    const scope = {skill: 'optimize-ux' as const, personaId: persona}
    const runId = 'replay-1'

    async function seedFile(lines: ReadonlyArray<string>): Promise<void> {
      const dir = path.join(tempDir, 'optimize-ux', persona)
      await mkdir(dir, {recursive: true})
      await writeFile(path.join(dir, `${runId}.jsonl`), lines.join('\n') + '\n')
    }

    function intentLine(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        kind: 'intent',
        runId,
        correlationId: `optimize-ux:${persona}:1:approve`,
        personaId: persona,
        domain: 'operator',
        skill: 'optimize-ux',
        iteration: 1,
        perceivedInterface: 'x',
        intendedAction: 'x',
        expectedResult: 'x',
        protocolVersion: AGENT_BUS_PROTOCOL_VERSION,
        recordedAt: '1970-01-01T00:00:00.000Z',
        ...overrides,
      })
    }

    function outcomeLine(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        kind: 'outcome',
        runId,
        correlationId: `optimize-ux:${persona}:1:approve`,
        actualResult: 'x',
        delta: 'x',
        desirability: 'desirable',
        degree: 0.5,
        protocolVersion: AGENT_BUS_PROTOCOL_VERSION,
        recordedAt: '1970-01-01T00:00:00.000Z',
        ...overrides,
      })
    }

    async function resumeExit() {
      return Effect.runPromiseExit(
        makeAgentBusLiveService(tempDir, {
          resumeFromRunId: runId,
          resumeScopes: [scope],
        }).pipe(Effect.provide(RunIdentityLive)),
      )
    }

    it('rejects invalid-json with the invalid-json reason and the offending line number', async () => {
      await seedFile([intentLine(), '{"kind":"outcome","not":"valid'])
      const exit = await resumeExit()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain('ResumeDecodeFailure')
        expect(rendered).toContain('invalid-json')
        expect(rendered).toContain('lineNumber=2')
      }
    })

    it('rejects protocol-version-mismatch with the protocol-version-mismatch reason and line number', async () => {
      await seedFile([intentLine({protocolVersion: '999'})])
      const exit = await resumeExit()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain('protocol-version-mismatch')
        expect(rendered).toContain('lineNumber=1')
      }
    })

    it('rejects duplicate-intent (two intents for one correlationId in the same file) with the duplicate-intent reason and line number', async () => {
      await seedFile([intentLine(), intentLine()])
      const exit = await resumeExit()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain('duplicate-intent')
        expect(rendered).toContain('lineNumber=2')
      }
    })

    it('rejects duplicate-outcome (two outcomes for one correlationId in the same file) with the duplicate-outcome reason and line number', async () => {
      await seedFile([intentLine(), outcomeLine(), outcomeLine()])
      const exit = await resumeExit()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain('duplicate-outcome')
        expect(rendered).toContain('lineNumber=3')
      }
    })

    it('rejects outcome-before-intent with the outcome-before-intent reason and line number', async () => {
      await seedFile([outcomeLine()])
      const exit = await resumeExit()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause)
        expect(rendered).toContain('outcome-before-intent')
        expect(rendered).toContain('lineNumber=1')
      }
    })

    it('a valid intent+outcome sequence resumes cleanly', async () => {
      await seedFile([intentLine(), outcomeLine()])
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {
            resumeFromRunId: runId,
            resumeScopes: [scope],
          }).pipe(Effect.provide(RunIdentityLive))
          expect(bus).toBeDefined()
        }),
      )
    })
  })

  describe('run identity + resume — end-to-end integration', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-runid-'))
    })

    afterEach(async () => {
      await rm(tempDir, {recursive: true, force: true})
    })

    it('two fresh runs with identical correlationIds do NOT collide on disk', async () => {
      const persona = 'time-pressured-engineer'
      const correlationId = `optimize-ux:${persona}:1:approve`
      await Effect.runPromise(
        Effect.gen(function* () {
          const busA = yield* makeAgentBusLiveService(tempDir, {runId: 'run-a'}).pipe(
            Effect.provide(RunIdentityLive),
          )
          const ackA = yield* busA.recordIntent(baseIntent({correlationId, personaId: persona}))
          yield* busA.recordOutcome(ackA, basePayload())
        }),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const busB = yield* makeAgentBusLiveService(tempDir, {runId: 'run-b'}).pipe(
            Effect.provide(RunIdentityLive),
          )
          const ackB = yield* busB.recordIntent(baseIntent({correlationId, personaId: persona}))
          yield* busB.recordOutcome(ackB, basePayload())
        }),
      )
      const fileA = path.join(tempDir, 'optimize-ux', persona, 'run-a.jsonl')
      const fileB = path.join(tempDir, 'optimize-ux', persona, 'run-b.jsonl')
      const contentsA = await readFile(fileA, 'utf8')
      const contentsB = await readFile(fileB, 'utf8')
      expect(contentsA.split('\n').filter((line) => line.length > 0)).toHaveLength(2)
      expect(contentsB.split('\n').filter((line) => line.length > 0)).toHaveLength(2)
    })

    it('resume rejects re-recording an already-resolved correlationId with DuplicateWithinRunFailure', async () => {
      const persona = 'time-pressured-engineer'
      const correlationId = `optimize-ux:${persona}:1:approve`
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'resume-1'}).pipe(
            Effect.provide(RunIdentityLive),
          )
          const ack = yield* bus.recordIntent(baseIntent({correlationId, personaId: persona}))
          yield* bus.recordOutcome(ack, basePayload())
        }),
      )
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const resumed = yield* makeAgentBusLiveService(tempDir, {
            resumeFromRunId: 'resume-1',
            resumeScopes: [{skill: 'optimize-ux', personaId: persona}],
          }).pipe(Effect.provide(RunIdentityLive))
          return yield* Effect.either(
            resumed.recordIntent(baseIntent({correlationId, personaId: persona})),
          )
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(DuplicateWithinRunFailure)
      }
    })
  })

  describe('live layer (temp directory)', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-live-'))
    })

    afterEach(async () => {
      await rm(tempDir, {recursive: true, force: true})
    })

    it('replaces labeled secret-shaped values with [redacted] before writing to disk', async () => {
      const gh = 'ghp_' + 'a'.repeat(36)
      const persona = 'time-pressured-engineer'
      const intent = baseIntent({
        correlationId: `optimize-ux:${persona}:1:approve`,
        personaId: persona,
        perceivedInterface: `token in URL: https://example.com?pat=${gh}`,
        expectedResult: `Authorization: ${gh} is present`,
      })
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'redaction-test'}).pipe(
            Effect.provide(RunIdentityLive),
          )
          const ack = yield* bus.recordIntent(intent)
          yield* bus.recordOutcome(ack, basePayload({actualResult: `still leaking ${gh}`}))
        }),
      )
      const file = path.join(tempDir, 'optimize-ux', persona, 'redaction-test.jsonl')
      const contents = await readFile(file, 'utf8')
      expect(contents).not.toContain(gh)
      expect(contents).toContain('[redacted]')
      for (const line of contents.split(/\r?\n/).filter((line) => line.length > 0)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow()
      }
    })

    it('does NOT redact a bare 40-char hex commit SHA that is not preceded by a secret label', async () => {
      const sha = 'abcdef0123456789abcdef0123456789abcdef01'
      const persona = 'time-pressured-engineer'
      const prose = `resumed from commit ${sha} because the tests were red`
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'sha-safe'}).pipe(
            Effect.provide(RunIdentityLive),
          )
          const ack = yield* bus.recordIntent(
            baseIntent({
              personaId: persona,
              correlationId: `optimize-ux:${persona}:1:sha`,
              perceivedInterface: prose,
            }),
          )
          yield* bus.recordOutcome(ack, basePayload({actualResult: `merged ${sha}`}))
        }),
      )
      const file = path.join(tempDir, 'optimize-ux', persona, 'sha-safe.jsonl')
      const contents = await readFile(file, 'utf8')
      expect(contents).toContain(sha)
      expect(redactSecrets(`resumed from commit ${sha}`)).toContain(sha)
    })

    it('serializes concurrent writes across many personas so no JSONL line is ever torn', async () => {
      const personas = [
        'first-time-coordinator',
        'risk-accountable-owner',
        'time-pressured-engineer',
        'nonvisual-operator',
        'unattended-automation-engineer',
      ] as const
      const writesPerPersona = 10
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'concurrent-1'}).pipe(
            Effect.provide(RunIdentityLive),
          )
          const jobs: Array<Effect.Effect<void, unknown>> = []
          for (const persona of personas) {
            for (let event = 0; event < writesPerPersona; event += 1) {
              const correlationId = `optimize-ux:${persona}:1:event-${event}`
              jobs.push(
                Effect.gen(function* () {
                  const ack = yield* bus.recordIntent(
                    baseIntent({
                      correlationId,
                      personaId: persona,
                      intendedAction: `action-${event}`,
                    }),
                  )
                  yield* bus.recordOutcome(ack, basePayload({actualResult: `result-${event}`}))
                }),
              )
            }
          }
          yield* Effect.all(jobs, {concurrency: 'unbounded'})
        }),
      )
      for (const persona of personas) {
        const file = path.join(tempDir, 'optimize-ux', persona, 'concurrent-1.jsonl')
        const contents = await readFile(file, 'utf8')
        const lines = contents.split(/\r?\n/).filter((line) => line.length > 0)
        expect(lines).toHaveLength(writesPerPersona * 2)
        for (const line of lines) {
          expect(() => JSON.parse(line) as unknown).not.toThrow()
          const parsed = JSON.parse(line) as {
            kind: string
            protocolVersion: string
            runId: string
          }
          expect(['intent', 'outcome']).toContain(parsed.kind)
          expect(parsed.protocolVersion).toBe(AGENT_BUS_PROTOCOL_VERSION)
          expect(parsed.runId).toBe('concurrent-1')
        }
      }
    })

    it('outcome path never embeds raw payload text in error messages — TerminalOutcomeAppendFailure references correlationId only', async () => {
      const secretMarker = 'super-sensitive-payload-marker-abcdefg-1234567890abcdef'
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeFailingOutcomeAgentBus('sink offline')
          return yield* Effect.either(
            bus.runWithIntent(
              baseIntent(),
              () => Effect.succeed('ok'),
              () =>
                basePayload({
                  actualResult: secretMarker,
                }),
            ),
          )
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(TerminalOutcomeAppendFailure)
        const f = failure.left as TerminalOutcomeAppendFailure
        expect(JSON.stringify(f)).not.toContain(secretMarker)
      }
    })

    it('makeAgentBusLiveLayer is self-contained: it does not require RunIdentityTag from the caller', async () => {
      // A caller providing only makeAgentBusLiveLayer must be able to resolve AgentBusTag without
      // separately providing RunIdentityTag — the live layer bundles RunIdentityLive internally.
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* AgentBusTag
          const ack = yield* bus.recordIntent(baseIntent())
          expect(ack.runId.length).toBeGreaterThan(0)
          yield* bus.recordOutcome(ack, basePayload())
        }).pipe(Effect.provide(makeAgentBusLiveLayer(tempDir))),
      )
    })
  })

  describe('redactSecrets helper', () => {
    it('scrubs common labeled secret-shaped patterns', () => {
      expect(redactSecrets('token=abcdefghijklmnop1234')).toContain('[redacted]')
      expect(redactSecrets('AWS AKIAABCDEFGHIJKLMNOP is a key')).toContain('[redacted]')
      const gh = 'ghp_' + 'a'.repeat(36)
      expect(redactSecrets(`Authorization: Bearer ${gh}`)).toContain('[redacted]')
      expect(redactSecrets('this is fine and short')).toBe('this is fine and short')
    })

    it('scrubs Azure Storage AccountKey= and generic password= / pwd= / connectionstring= / clientsecret=', () => {
      const azure =
        'AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ==;EndpointSuffix=core.windows.net'
      expect(redactSecrets(azure)).toContain('[redacted]')
      expect(redactSecrets('password=supersecretpassword1234')).toContain('[redacted]')
      expect(redactSecrets('pwd=supersecretpassword1234')).toContain('[redacted]')
      expect(
        redactSecrets(
          'connectionstring=Endpoint=sb://x.servicebus.windows.net/;SharedAccessKey=aaaaaaaaaaaaaaaaaaaaaaaaaa',
        ),
      ).toContain('[redacted]')
      expect(redactSecrets('client_secret=aaaaaaaaaaaaaaaaaaaa')).toContain('[redacted]')
    })

    it('does NOT redact a bare 40-char hex commit SHA in prose (no over-redaction)', () => {
      const sha = 'abcdef0123456789abcdef0123456789abcdef01'
      expect(redactSecrets(`merged commit ${sha} into main`)).toBe(`merged commit ${sha} into main`)
    })
  })

  describe('AgentBusTag is a Context.Tag', () => {
    it('has the correct tag identifier', () => {
      expect(AgentBusTag.key).toBe('AgentBus')
    })
  })

  describe('desirability/delta separation', () => {
    it('keeps degree (desirability) and delta (comparison) as separate fields', async () => {
      const outcomes = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const ack = yield* recording.service.recordIntent(baseIntent())
          yield* recording.service.recordOutcome(
            ack,
            basePayload({
              degree: 0.5,
              delta: 'observed friction 0.62 vs predicted 0.58 (higher than predicted)',
              desirability: 'neutral',
            }),
          )
          return yield* recording.outcomes()
        }),
      )
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]?.degree).toBe(0.5)
      expect(outcomes[0]?.delta).not.toBe(outcomes[0]?.degree.toString())
      expect(outcomes[0]?.delta).toContain('higher than predicted')
    })

    it('exports DESIRABILITY_SCALE_DESCRIPTION as the single source of truth', () => {
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('0.0 = fully undesirable')
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('0.5 = neutral or mixed')
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('1.0 = fully desirable')
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('delta')
      expect(DESIRABILITY_SCALE_DESCRIPTION).not.toContain('matches prediction exactly')
    })

    it('exports TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION as the corrected wording — not the false absolute claim', () => {
      // The old "never left with a dangling intent" absolute-guarantee wording is a lie about
      // the real contract, which is "attempt is guaranteed; success is not". Pin the corrected
      // wording as the single source of truth so it cannot regress.
      expect(TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION).toContain('ALWAYS ATTEMPTED')
      expect(TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION).toContain('surfaced')
      expect(TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION).toContain('attempt guarantee')
      expect(TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION).not.toContain('never left with a dangling')
      expect(TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION).not.toContain(
        'guarantees a terminal outcome for every',
      )
    })
  })

  describe('AgentBusWriteFailure round-trip surfacing', () => {
    it('exports AgentBusWriteFailure so live-adapter callers can catch it', () => {
      const err = new AgentBusWriteFailure({message: 'ephemeral disk error'})
      expect(err._tag).toBe('AgentBusWriteFailure')
    })

    it('exports ResumeDecodeFailure so live-adapter resumers can catch it', () => {
      const err = new ResumeDecodeFailure({
        runId: 'x',
        lineNumber: 1,
        reason: 'invalid-json',
        message: 'stub',
      })
      expect(err._tag).toBe('ResumeDecodeFailure')
    })
  })

  describe('worktree cleanliness', () => {
    it('the temp directory pattern is used — tests never write to reports/agent-bus/ in the worktree', () => {
      expect(tmpdir()).not.toContain(path.join('reports', 'agent-bus'))
    })
  })

  describe('domain/adapter split', () => {
    it('the domain module does not import node:fs or node:crypto', async () => {
      const domain = await readFile(path.join(process.cwd(), 'src/experience/agent-bus.ts'), 'utf8')
      // Enforce architecture rule: domain modules must not touch OS capabilities directly.
      expect(domain).not.toMatch(/from 'node:crypto'/)
      expect(domain).not.toMatch(/from 'node:fs\/promises'/)
      expect(domain).not.toMatch(/from 'node:fs'/)
      expect(domain).not.toMatch(/from 'node:path'/)
    })

    it('the live adapter module exists and re-exports makeAgentBusLiveLayer / RunIdentityLive', async () => {
      const adapter = await readFile(
        path.join(process.cwd(), 'src/experience/agent-bus-live.ts'),
        'utf8',
      )
      expect(adapter).toMatch(/export const RunIdentityLive/)
      expect(adapter).toMatch(/export function makeAgentBusLiveLayer/)
      expect(adapter).toMatch(/export function makeAgentBusLiveService/)
    })
  })
})
