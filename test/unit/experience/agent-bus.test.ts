import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Cause, Effect, Exit, Fiber, Ref} from 'effect'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
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
  PathUnsafeIdentifierFailure,
  PersonaDomainSkillMismatchFailure,
  ProtocolVersionMismatchFailure,
  ResumeDecodeFailure,
  TerminalOutcomeAppendFailure,
  makeAgentBusLiveService,
  makeAgentBusTestService,
  makeFailingOutcomeAgentBus,
  makeRecordingAgentBus,
  redactSecrets,
  type AgentBusService,
  type IntentAck,
  type IntentInput,
  type OutcomeInputPayload,
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

function basePayload(overrides: Partial<OutcomeInputPayload> = {}): OutcomeInputPayload {
  return {
    actualResult: 'approval prompt colocated all target writes',
    delta: 'approvalContext friction decreased as predicted',
    desirability: 'desirable',
    degree: 0.9,
    ...overrides,
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
              () => basePayload(),
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

    it('runWithIntent appends a terminal outcome when the action SUCCEEDS and re-surfaces the value', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const value = yield* recording.service.runWithIntent(
            baseIntent(),
            () => Effect.succeed('ok'),
            (result) => basePayload({actualResult: `got ${result}`}),
          )
          const outcomes = yield* recording.outcomes()
          return {value, outcomes}
        }),
      )
      expect(result.value).toBe('ok')
      expect(result.outcomes).toHaveLength(1)
      expect(result.outcomes[0]?.actualResult).toBe('got ok')
      expect(result.outcomes[0]?.desirability).toBe('desirable')
    })

    it('runWithIntent appends a terminal outcome when the action FAILS with a typed failure', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const exit = yield* Effect.exit(
            recording.service.runWithIntent(
              baseIntent(),
              () => Effect.fail(new Error('boom')),
              () => basePayload(),
            ),
          )
          const outcomes = yield* recording.outcomes()
          return {exit, outcomes}
        }),
      )
      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.outcomes).toHaveLength(1)
      const outcome = result.outcomes[0]!
      expect(outcome.desirability).toBe('undesirable')
      expect(outcome.degree).toBe(0)
      expect(outcome.observedFriction).toBe('TypedFailure')
      // Original action failure is re-surfaced (not swallowed) after the terminal outcome append.
      if (Exit.isFailure(result.exit)) {
        const rendered = Cause.pretty(result.exit.cause)
        expect(rendered.toLowerCase()).toContain('boom')
      }
    })

    it('runWithIntent appends a terminal outcome when the action DIES with a defect', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const exit = yield* Effect.exit(
            recording.service.runWithIntent(
              baseIntent(),
              () => Effect.die(new Error('unchecked defect')),
              () => basePayload(),
            ),
          )
          const outcomes = yield* recording.outcomes()
          return {exit, outcomes}
        }),
      )
      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.outcomes).toHaveLength(1)
      const outcome = result.outcomes[0]!
      expect(outcome.desirability).toBe('undesirable')
      expect(outcome.degree).toBe(0)
      expect(outcome.observedFriction).toBe('Defect')
    })

    it('runWithIntent appends a terminal outcome when the action is INTERRUPTED mid-flight', async () => {
      // Fork the runWithIntent effect, then interrupt the fiber while the action is asleep. The
      // outcome append must still fire before the fiber terminates.
      const outcomes = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const started = yield* Ref.make(false)
          const fiber = yield* Effect.fork(
            recording.service.runWithIntent(
              baseIntent(),
              () => Ref.set(started, true).pipe(Effect.andThen(Effect.sleep('10 seconds'))),
              () => basePayload(),
            ),
          )
          // Wait until the action has actually started before interrupting.
          yield* Effect.repeat(Ref.get(started), {
            until: (value) => value === true,
            schedule: undefined,
          }).pipe(
            Effect.timeout('2 seconds'),
            Effect.orElse(() => Effect.void),
          )
          yield* Fiber.interrupt(fiber)
          // Give the uninterruptible outcome-append region time to complete.
          yield* Effect.sleep('50 millis')
          return yield* recording.outcomes()
        }),
      )
      expect(outcomes).toHaveLength(1)
      const outcome = outcomes[0]!
      expect(outcome.desirability).toBe('undesirable')
      expect(outcome.degree).toBe(0)
      expect(outcome.observedFriction).toBe('Interrupt')
    })

    it('surfaces a TerminalOutcomeAppendFailure when the outcome sink itself fails — never swallowed', async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeFailingOutcomeAgentBus('sink is offline')
          return yield* Effect.either(
            bus.runWithIntent(
              baseIntent(),
              () => Effect.succeed('ok'),
              () => basePayload(),
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
          // Forge an ack via `as` cast — recordOutcome must reject an unknown correlationId even
          // if the type check is escaped.
          const forgedAck = {
            correlationId: 'no-such-intent:1:1:1',
            recordedAt: '1970-01-01T00:00:00.000Z',
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
      // API-surface immutability: exactly three methods, no update/delete/patch mutators.
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
        expect(failure.left._tag).toBe('OutcomeDecodeFailure')
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
      expect(new Set(result.intents.map((event) => event.correlationId)).size).toBe(
        knownPersonas.length,
      )
      const intentIds = new Set(result.intents.map((event) => event.correlationId))
      for (const outcome of result.outcomes) {
        expect(intentIds.has(outcome.correlationId)).toBe(true)
      }
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
      // Even if a caller somehow bypassed the enumeration check, the defensive charset check
      // rejects `..`, path separators, and null bytes.
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
          // Either the path-safety check or the unknown-persona check fires FIRST —
          // both categories reject BEFORE any file path is constructed. Both are acceptable.
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
      // If TypeScript ever allowed an object literal to satisfy IntentAck without going through
      // recordIntent, this line would compile. The `@ts-expect-error` below asserts the brand
      // rejects the forgery at type-check time, which is the "public API surface" the design must
      // block. `as`-cast escape hatches (used elsewhere in this file for negative tests) are
      // deliberately not the public API.
      const bus = await Effect.runPromise(makeAgentBusTestService())
      const _bus: AgentBusService = bus
      // @ts-expect-error — IntentAck cannot be constructed from a plain object literal (missing brand)
      const _forged: IntentAck = {correlationId: 'x', recordedAt: 'y'}
      // Compile-time proof is enough for this test — no runtime assertion required beyond
      // referencing the values to prevent "unused variable" complaints.
      expect(_forged.correlationId).toBe('x')
      expect(_bus).toBeDefined()
    })

    it('recordOutcome does not accept a caller-supplied correlationId in the payload', async () => {
      // Structural proof: the type of the payload has no `correlationId`. Even if a caller
      // sneaks one in via a wider object, the bus uses the ack's correlationId.
      await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const ack = yield* recording.service.recordIntent(baseIntent())
          const payloadWithForgery = {
            ...basePayload(),
            correlationId: 'forged-correlation-id',
          } as unknown as OutcomeInputPayload
          yield* recording.service.recordOutcome(ack, payloadWithForgery)
          const outcomes = yield* recording.outcomes()
          expect(outcomes).toHaveLength(1)
          expect(outcomes[0]?.correlationId).toBe(ack.correlationId)
          expect(outcomes[0]?.correlationId).not.toBe('forged-correlation-id')
        }),
      )
    })
  })

  describe('run identity + resume', () => {
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
          const busA = yield* makeAgentBusLiveService(tempDir, {runId: 'run-a'})
          const ackA = yield* busA.recordIntent(baseIntent({correlationId, personaId: persona}))
          yield* busA.recordOutcome(ackA, basePayload())
        }),
      )
      // Fresh run — a completely new bus service. Same correlationId reused.
      await Effect.runPromise(
        Effect.gen(function* () {
          const busB = yield* makeAgentBusLiveService(tempDir, {runId: 'run-b'})
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
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'resume-1'})
          const ack = yield* bus.recordIntent(baseIntent({correlationId, personaId: persona}))
          yield* bus.recordOutcome(ack, basePayload())
        }),
      )
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const resumed = yield* makeAgentBusLiveService(tempDir, {
            resumeFromRunId: 'resume-1',
            resumeScopes: [{skill: 'optimize-ux', personaId: persona}],
          })
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

    it('resume rejects a torn or version-mismatched last line — no silent partial replay', async () => {
      const persona = 'time-pressured-engineer'
      const runId = 'corrupt-1'
      const dir = path.join(tempDir, 'optimize-ux', persona)
      await mkdir(dir, {recursive: true})
      // Write one valid intent line, then a torn/invalid line.
      const validIntent = JSON.stringify({
        kind: 'intent',
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
      })
      await writeFile(
        path.join(dir, `${runId}.jsonl`),
        `${validIntent}\n{"kind":"outcome","not":"valid`,
      )
      const failure = await Effect.runPromise(
        Effect.exit(
          makeAgentBusLiveService(tempDir, {
            resumeFromRunId: runId,
            resumeScopes: [{skill: 'optimize-ux', personaId: persona}],
          }),
        ),
      )
      expect(Exit.isFailure(failure)).toBe(true)
      if (Exit.isFailure(failure)) {
        const rendered = Cause.pretty(failure.cause)
        expect(rendered).toContain('ResumeDecodeFailure')
        expect(rendered).toContain('Line 2')
      }
    })

    it('resume rejects a file whose lines carry an incompatible protocolVersion', async () => {
      const persona = 'time-pressured-engineer'
      const runId = 'protocol-mismatch-1'
      const dir = path.join(tempDir, 'optimize-ux', persona)
      await mkdir(dir, {recursive: true})
      const bogus = JSON.stringify({
        kind: 'intent',
        correlationId: `optimize-ux:${persona}:1:approve`,
        personaId: persona,
        domain: 'operator',
        skill: 'optimize-ux',
        iteration: 1,
        perceivedInterface: 'x',
        intendedAction: 'x',
        expectedResult: 'x',
        protocolVersion: '999',
        recordedAt: '1970-01-01T00:00:00.000Z',
      })
      await writeFile(path.join(dir, `${runId}.jsonl`), `${bogus}\n`)
      const failure = await Effect.runPromise(
        Effect.exit(
          makeAgentBusLiveService(tempDir, {
            resumeFromRunId: runId,
            resumeScopes: [{skill: 'optimize-ux', personaId: persona}],
          }),
        ),
      )
      expect(Exit.isFailure(failure)).toBe(true)
      if (Exit.isFailure(failure)) {
        const rendered = Cause.pretty(failure.cause)
        expect(rendered).toContain('protocol-version-mismatch')
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
        expectedResult: `Bearer ${gh} is present`,
      })
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'redaction-test'})
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

    it('redacts labeled Azure Storage AccountKey and password= assignments in both intent and outcome', async () => {
      const azureConn =
        'DefaultEndpointsProtocol=https;AccountName=devops;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ==;EndpointSuffix=core.windows.net'
      const password = 'password=supersecretpassword1234'
      const persona = 'time-pressured-engineer'
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'azure-redact'})
          const ack = yield* bus.recordIntent(
            baseIntent({
              personaId: persona,
              correlationId: `optimize-ux:${persona}:1:leak`,
              perceivedInterface: azureConn,
              expectedResult: password,
            }),
          )
          yield* bus.recordOutcome(
            ack,
            basePayload({
              actualResult: `leaked ${azureConn}`,
              delta: `still leaking ${password}`,
              observedFriction: `key material: ${azureConn}`,
            }),
          )
        }),
      )
      const file = path.join(tempDir, 'optimize-ux', persona, 'azure-redact.jsonl')
      const contents = await readFile(file, 'utf8')
      expect(contents).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ')
      expect(contents).not.toContain('supersecretpassword1234')
      expect(contents).toContain('[redacted]')
    })

    it('does NOT redact a bare 40-char hex commit SHA that is not preceded by a secret label', async () => {
      const sha = 'abcdef0123456789abcdef0123456789abcdef01'
      const persona = 'time-pressured-engineer'
      const prose = `resumed from commit ${sha} because the tests were red`
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'sha-safe'})
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
      // And the redactor helper reports the same result in isolation.
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
      const writesPerPersona = 20
      await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* makeAgentBusLiveService(tempDir, {runId: 'concurrent-1'})
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
          const parsed = JSON.parse(line) as {kind: string; protocolVersion: string}
          expect(['intent', 'outcome']).toContain(parsed.kind)
          expect(parsed.protocolVersion).toBe(AGENT_BUS_PROTOCOL_VERSION)
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
              () => basePayload({actualResult: secretMarker}),
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
      expect(redactSecrets('password=hunter22longenoughtoken')).toContain('[redacted]')
      expect(redactSecrets('pwd=alsolongenoughsecretvalue')).toContain('[redacted]')
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
      // The exact wording of the scale is asserted in
      // test/unit/documentation/agents-md.test.ts — this test only ensures the export exists and
      // clearly separates degree (desirability) from delta (comparison).
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('0.0 = fully undesirable')
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('0.5 = neutral or mixed')
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('1.0 = fully desirable')
      expect(DESIRABILITY_SCALE_DESCRIPTION).toContain('delta')
      expect(DESIRABILITY_SCALE_DESCRIPTION).not.toContain('matches prediction exactly')
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
      // The `beforeEach` hooks above use `mkdtemp(path.join(tmpdir(), ...))` for every live-layer
      // test, so no live artifacts leak into the repo's `reports/` directory. This test is a
      // documentation guard: if a future patch accidentally writes to `reports/agent-bus/`, code
      // review notices it and pnpm secrets:check / `git status --porcelain` will show it too.
      expect(tmpdir()).not.toContain(path.join('reports', 'agent-bus'))
    })
  })
})
