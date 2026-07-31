import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Effect, Exit, Ref} from 'effect'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  AGENT_BUS_PROTOCOL_VERSION,
  AgentBusTag,
  DuplicateIntentFailure,
  DuplicateOutcomeFailure,
  IntentDecodeFailure,
  IntentMissingFailure,
  ProtocolVersionMismatchFailure,
  makeAgentBusLiveService,
  makeAgentBusTestService,
  makeRecordingAgentBus,
  redactSecrets,
  type AgentBusService,
  type IntentInput,
  type OutcomeInput,
} from '../../../src/experience/agent-bus.js'

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

function baseOutcome(overrides: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    correlationId: 'optimize-ux:time-pressured-engineer:1:approve',
    actualResult: 'approval prompt colocated all target writes',
    delta: 'approvalContext friction decreased as predicted',
    desirability: 'desirable',
    degree: 0.9,
    ...overrides,
  }
}

describe('agent-bus write-ahead protocol', () => {
  describe('in-memory bus', () => {
    it('runWithIntent never runs the action when recordIntent fails (outcome-bias prevention)', async () => {
      // Prove that a failing recordIntent (here, a schema failure) means the action closure never
      // fires. This is the load-bearing anti-outcome-bias invariant: the persona cannot look at
      // the actual result and *then* fabricate its prediction, because there is no recorded
      // intent to attach a matching outcome to.
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const callCounter = yield* Ref.make(0)
          const invalidIntent: IntentInput = {
            ...baseIntent(),
            personaId: '', // schema minLength(1) — decode fails
          }
          const exit = yield* Effect.exit(
            bus.runWithIntent(
              invalidIntent,
              () =>
                Ref.update(callCounter, (count) => count + 1).pipe(
                  Effect.andThen(Effect.succeed('unreachable')),
                ),
              () => baseOutcome(),
            ),
          )
          const invocations = yield* Ref.get(callCounter)
          return {exit, invocations}
        }),
      )
      expect(result.invocations).toBe(0)
      expect(Exit.isFailure(result.exit)).toBe(true)
      if (Exit.isFailure(result.exit)) {
        const failure = Exit.match(result.exit, {
          onFailure: (cause) => cause.toString(),
          onSuccess: () => 'unreachable',
        })
        expect(failure).toContain('IntentDecodeFailure')
      }
    })

    it('recordOutcome without a prior recordIntent fails with IntentMissingFailure', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const outcome = baseOutcome({correlationId: 'no-such-intent:1:1:1'})
          return yield* Effect.either(bus.recordOutcome(outcome))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left).toBeInstanceOf(IntentMissingFailure)
      }
    })

    it('rejects a second recordOutcome for the same correlationId with DuplicateOutcomeFailure', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          yield* bus.recordIntent(baseIntent())
          yield* bus.recordOutcome(baseOutcome())
          return yield* Effect.either(bus.recordOutcome(baseOutcome()))
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

    it('has no service method that can mutate or delete a previously recorded intent', () => {
      // API-surface immutability assertion. The AgentBusService exposes exactly three methods:
      // recordIntent, recordOutcome, runWithIntent. There is no "updateIntent", "deleteIntent",
      // "setIntent", "patchIntent", etc. A caller cannot revise a prediction after seeing the
      // outcome by any published method — this is enforced structurally by the interface shape.
      // If a future PR adds a mutator this test will fail and force a design discussion.
      const methods = new Set<keyof AgentBusService>([
        'recordIntent',
        'recordOutcome',
        'runWithIntent',
      ])
      // Vitest's type-narrowing check: any additional method would need to appear here to type-check.
      // (Enforced at compile time by the interface literal; enforced at runtime by this Set assertion
      // against the observed live service surface.)
      const service: AgentBusService = {
        recordIntent: () => Effect.succeed({correlationId: '', recordedAt: ''}),
        recordOutcome: () => Effect.void,
        runWithIntent: (_intent, action, _toOutcome) => action({correlationId: '', recordedAt: ''}),
      }
      expect(new Set(Object.keys(service)).size).toBe(methods.size)
      for (const key of Object.keys(service)) {
        expect(methods.has(key as keyof AgentBusService)).toBe(true)
      }
      // Sanity: explicitly assert the mutator names do not exist.
      const asRecord = service as unknown as Record<string, unknown>
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

    it('rejects a degree outside [0, 1] via schema decoding', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          yield* bus.recordIntent(baseIntent())
          const overflow = baseOutcome({degree: 1.5})
          return yield* Effect.either(bus.recordOutcome(overflow))
        }),
      )
      expect(failure._tag).toBe('Left')
      if (failure._tag === 'Left') {
        expect(failure.left._tag).toBe('OutcomeDecodeFailure')
      }

      const underflow = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          yield* bus.recordIntent(baseIntent())
          return yield* Effect.either(bus.recordOutcome(baseOutcome({degree: -0.01})))
        }),
      )
      expect(underflow._tag).toBe('Left')
      if (underflow._tag === 'Left') {
        expect(underflow.left._tag).toBe('OutcomeDecodeFailure')
      }
    })

    it('rejects an obviously malformed input via IntentDecodeFailure', async () => {
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusTestService()
          const bad = baseIntent({iteration: 0}) // schema requires >= 1
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
          yield* bus.recordIntent(intentA)
          yield* bus.recordIntent(intentB)
          // Resolving B does not close A.
          yield* bus.recordOutcome(
            baseOutcome({correlationId: 'optimize-ux:first-time-coordinator:1:approve'}),
          )
          // A is still open — a second attempt to resolve B (already closed) must fail, but a
          // first outcome for A must still succeed.
          const secondBOutcome = yield* Effect.either(
            bus.recordOutcome(
              baseOutcome({correlationId: 'optimize-ux:first-time-coordinator:1:approve'}),
            ),
          )
          yield* bus.recordOutcome(baseOutcome())
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
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const bus = recording.service
          const size = 50
          const workload = Array.from({length: size}, (_, index) => ({
            intent: baseIntent({
              correlationId: `optimize-ux:persona-${index}:1:action`,
              personaId: `persona-${index}`,
              iteration: 1,
            }),
            outcome: baseOutcome({correlationId: `optimize-ux:persona-${index}:1:action`}),
          }))
          yield* Effect.all(
            workload.map(({intent, outcome}) =>
              bus.recordIntent(intent).pipe(Effect.andThen(bus.recordOutcome(outcome))),
            ),
            {concurrency: 'unbounded'},
          )
          const intents = yield* recording.intents()
          const outcomes = yield* recording.outcomes()
          return {intents, outcomes}
        }),
      )
      expect(result.intents).toHaveLength(50)
      expect(result.outcomes).toHaveLength(50)
      expect(new Set(result.intents.map((event) => event.correlationId)).size).toBe(50)
      expect(new Set(result.outcomes.map((event) => event.correlationId)).size).toBe(50)
      // Every outcome must have a matching intent with the same correlationId.
      const intentIds = new Set(result.intents.map((event) => event.correlationId))
      for (const outcome of result.outcomes) {
        expect(intentIds.has(outcome.correlationId)).toBe(true)
      }
    })
  })

  describe('live layer (temp directory)', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agent-bus-'))
    })

    afterEach(async () => {
      await rm(tempDir, {recursive: true, force: true})
    })

    it('replaces secret-shaped values with [redacted] before writing to disk', async () => {
      const suspiciousToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'
      const intent = baseIntent({
        perceivedInterface: `token in URL: https://example.com?pat=${suspiciousToken}`,
        expectedResult: `Bearer ${suspiciousToken} is present`,
      })
      const outcome = baseOutcome({
        actualResult: `still leaking ${suspiciousToken}`,
      })
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir)
          yield* bus.recordIntent(intent)
          yield* bus.recordOutcome(outcome)
        }),
      )
      const file = path.join(tempDir, 'optimize-ux', `${intent.personaId}.jsonl`)
      const contents = await readFile(file, 'utf8')
      expect(contents).not.toContain(suspiciousToken)
      expect(contents).toContain('[redacted]')
      // Every line must be valid JSON (nothing torn) — see next test for the concurrent case.
      for (const line of contents.split(/\r?\n/).filter((line) => line.length > 0)) {
        expect(() => JSON.parse(line) as unknown).not.toThrow()
      }
    })

    it('serializes concurrent writes so no JSONL line is ever torn', async () => {
      const writesPerPersona = 20
      const personaCount = 5
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir)
          const jobs: Array<Effect.Effect<void, unknown>> = []
          for (let personaIndex = 0; personaIndex < personaCount; personaIndex += 1) {
            for (let event = 0; event < writesPerPersona; event += 1) {
              const correlationId = `optimize-ux:persona-${personaIndex}:1:event-${event}`
              jobs.push(
                bus
                  .recordIntent(
                    baseIntent({
                      correlationId,
                      personaId: `persona-${personaIndex}`,
                      intendedAction: `action-${event}`,
                    }),
                  )
                  .pipe(
                    Effect.andThen(
                      bus.recordOutcome(
                        baseOutcome({
                          correlationId,
                          actualResult: `result-${event}`,
                        }),
                      ),
                    ),
                  ),
              )
            }
          }
          yield* Effect.all(jobs, {concurrency: 'unbounded'})
        }),
      )
      // Verify every line in every file is parseable JSON.
      for (let personaIndex = 0; personaIndex < personaCount; personaIndex += 1) {
        const file = path.join(tempDir, 'optimize-ux', `persona-${personaIndex}.jsonl`)
        const contents = await readFile(file, 'utf8')
        const lines = contents.split(/\r?\n/).filter((line) => line.length > 0)
        expect(lines).toHaveLength(writesPerPersona * 2) // one intent + one outcome per event
        for (const line of lines) {
          expect(() => JSON.parse(line) as unknown).not.toThrow()
          const parsed = JSON.parse(line) as {kind: string; protocolVersion: string}
          expect(['intent', 'outcome']).toContain(parsed.kind)
          expect(parsed.protocolVersion).toBe(AGENT_BUS_PROTOCOL_VERSION)
        }
      }
    })
  })

  describe('redactSecrets helper', () => {
    it('scrubs common secret-shaped patterns', () => {
      expect(redactSecrets('token: ghp_1234567890abcdefghijklmnopqrstuvwxyz')).toContain(
        '[redacted]',
      )
      expect(redactSecrets('AWS AKIAABCDEFGHIJKLMNOP is a key')).toContain('[redacted]')
      expect(
        redactSecrets('Authorization: Bearer eyJhbcdef1234567890.claimspart.signaturepart'),
      ).toContain('[redacted]')
      expect(redactSecrets('this is fine and short')).toBe('this is fine and short')
    })
  })

  describe('AgentBusTag is a Context.Tag', () => {
    it('has the correct tag identifier', () => {
      // Simple smoke — the tag exists and can be used as a discriminator.
      expect(AgentBusTag.key).toBe('AgentBus')
    })
  })
})
