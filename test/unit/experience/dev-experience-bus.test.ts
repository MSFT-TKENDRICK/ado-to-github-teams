import {existsSync, readdirSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {Cause, Effect, Exit, Ref} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  countPackageScripts,
  danglingTurboInputs,
  documentedScriptRatio,
  duplicateFormatConfigCount,
  hookEnforcementStatus,
} from '../../../src/experience/dev-experience.js'
import {
  DX_AREA_CATALOG,
  DEFAULT_DX_ITERATIONS,
  buildIntent,
  classifyDxAreaOutcome,
  rotateAreas,
  runIterationThroughBus,
  type DxArea,
  type SignalSnapshot,
} from '../../../skills/optimize-dx/scripts/optimize-dx.js'
import {
  makeAgentBusTestService,
  makeRecordingAgentBus,
  type AgentBusFailure,
  type AgentBusService,
  type IntentAck,
  type IntentInput,
  type ToOutcome,
} from '../../../src/experience/agent-bus.js'

const REPO_ROOT = process.cwd()

// Minimal, deterministic signal snapshot used to drive the bus wiring without touching disk.
// Values match the healthy shape described in references/measurements.md so the classifier
// hits its "desirable" branches wherever a real read would.
async function loadRealSnapshot(): Promise<SignalSnapshot> {
  const pkgRaw = await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw) as {
    scripts?: Record<string, unknown>
    devDependencies?: Record<string, string>
  }
  const turboRaw = await readFile(path.join(REPO_ROOT, 'turbo.json'), 'utf8')
  const turbo = JSON.parse(turboRaw) as {tasks: Record<string, {inputs?: readonly string[]}>}
  const scriptNames = pkg.scripts ? Object.keys(pkg.scripts) : []
  const rootEntries = readdirSync(REPO_ROOT)
  return {
    scriptCount: countPackageScripts(pkg),
    documentedRatio: documentedScriptRatio(scriptNames, scriptNames),
    hookStatus: hookEnforcementStatus({
      hasLefthookConfig: existsSync(path.join(REPO_ROOT, 'lefthook.yml')),
      hasLefthookDependency: Boolean(pkg.devDependencies?.lefthook),
    }),
    prettierConfigCount: duplicateFormatConfigCount(rootEntries),
    danglingTurbo: danglingTurboInputs(turbo, (rel) => existsSync(path.join(REPO_ROOT, rel))),
  }
}

// A minimal bus that WILL fail recordIntent (schema failure via empty personaId). Used to prove
// that the measurement action never runs when the write-ahead intent cannot be appended — the
// load-bearing anti-outcome-bias invariant applied to the DX side.
function makeIntentFailingBus(callCounter: Ref.Ref<number>): Effect.Effect<AgentBusService> {
  return Effect.gen(function* () {
    const real = yield* makeAgentBusTestService()
    return {
      recordIntent: () =>
        Effect.gen(function* () {
          yield* Ref.update(callCounter, (count) => count + 1)
          return yield* real.recordIntent({
            correlationId: 'x',
            personaId: '', // schema minLength(1) → IntentDecodeFailure
            domain: 'developer',
            skill: 'optimize-dx',
            iteration: 1,
            perceivedInterface: '',
            intendedAction: '',
            expectedResult: '',
          } as IntentInput)
        }),
      recordOutcome: real.recordOutcome,
      runWithIntent: <A, E, R>(
        _intent: IntentInput,
        action: (ack: IntentAck) => Effect.Effect<A, E, R>,
        toOutcome: ToOutcome<A, E>,
      ): Effect.Effect<A, E | AgentBusFailure, R> =>
        Effect.gen(function* () {
          // Route recordIntent through the failing branch first — the action must never run.
          const ack = yield* Effect.fail<AgentBusFailure>({
            _tag: 'IntentDecodeFailure',
            message: 'test-forced failure',
          } as AgentBusFailure) as Effect.Effect<IntentAck, AgentBusFailure, R>
          const result = yield* action(ack)
          yield* real.recordOutcome(
            ack,
            toOutcome(
              // action never runs on this path; if it did, we synthesize an Exit for typing.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              {_tag: 'Success', value: result} as any,
              ack,
              {
                correlationId: ack.correlationId,
                runId: ack.runId,
                personaId: 'cli-contributor-engineer',
                domain: 'developer',
                skill: 'optimize-dx',
                iteration: 1,
                perceivedInterface: '',
                intendedAction: '',
                expectedResult: '',
                recordedAt: ack.recordedAt,
              },
            ),
          )
          return result
        }),
    }
  })
}

describe('optimize-dx write-ahead persona bus wiring', () => {
  it('exposes an expectedObservation for every one of the fifteen DX areas', () => {
    expect(DX_AREA_CATALOG).toHaveLength(15)
    for (const area of DX_AREA_CATALOG) {
      expect(area.expectedObservation.length).toBeGreaterThan(60)
    }
  })

  it('gives every area a distinguishable prediction — not a copy-pasted string', () => {
    const predictions = new Set(DX_AREA_CATALOG.map((area) => area.expectedObservation))
    expect(predictions.size).toBe(DX_AREA_CATALOG.length)
  })

  it('every prediction names the area or its load-bearing signal by concrete term', () => {
    // Guards against a bland "I expect things to be fine" prediction that would pass the length
    // check above without being genuinely persona-authentic. Each area must name a concrete
    // artifact, signal, or condition it is predicting about.
    const CONCRETE_ANCHORS: Record<string, ReadonlyArray<string>> = {
      documentation: ['documentedScriptRatio', 'CONTRIBUTING'],
      'repository-structure-and-config': ['prettier', 'turbo'],
      'local-environment-and-onboarding': ['scriptCount', 'hookStatus'],
      'file-folder-hierarchy': ['top-level', 'directories'],
      'projects-and-workspaces': ['pnpm-workspace', 'apps/'],
      'packages-and-dependencies': ['hookStatus', 'lefthook'],
      'developer-tools': ['scriptCount', 'documentedRatio'],
      'git-hooks': ['lefthook', 'enforced'],
      'git-github-cli-and-extensions': ['gh', 'extension'],
      devcontainers: ['.devcontainer'],
      dotfiles: ['dotfiles'],
      'cli-invocation-and-naming': ['a2g', 'executable'],
      'packaging-and-distribution': ['@msft-tkendrick/a2g', 'tarball'],
      'release-and-versioning': ['0.x.x', 'preview'],
      'build-package-and-deploy': ['local World', 'Azure', 'Workflow'],
    }
    for (const area of DX_AREA_CATALOG) {
      const anchors = CONCRETE_ANCHORS[area.id]
      expect(anchors, `no anchors registered for area ${area.id}`).toBeDefined()
      if (!anchors) continue
      const matched = anchors.some((anchor) =>
        area.expectedObservation.toLowerCase().includes(anchor.toLowerCase()),
      )
      expect(
        matched,
        `area ${area.id} expectedObservation must name one of ${JSON.stringify(anchors)}`,
      ).toBe(true)
    }
  })

  it('rejects self-excusing write-ahead predictions that normalize known drift', () => {
    for (const area of DX_AREA_CATALOG) {
      expect(area.expectedObservation).not.toMatch(
        /fall outside|newly[- ]added scripts? (?:may|can)|a few .* still (?:fall|remain)|undocumented (?:is|are) acceptable/i,
      )
    }
  })

  it('buildIntent stamps the shared skill/domain/persona/protocol shape used by the bus', () => {
    const area = DX_AREA_CATALOG[0]!
    const intent = buildIntent(area, 4)
    expect(intent.correlationId).toBe(`optimize-dx:cli-contributor-engineer:4:${area.id}`)
    expect(intent.personaId).toBe('cli-contributor-engineer')
    expect(intent.domain).toBe('developer')
    expect(intent.skill).toBe('optimize-dx')
    expect(intent.iteration).toBe(4)
    expect(intent.expectedResult).toBe(area.expectedObservation)
  })

  it('routes every iteration in a complete default run through recordIntent BEFORE measurement', async () => {
    const snapshot = await loadRealSnapshot()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const recording = yield* makeRecordingAgentBus()
        const actionCounter = yield* Ref.make(0)
        const measuredBus: AgentBusService = {
          recordIntent: recording.service.recordIntent,
          recordOutcome: recording.service.recordOutcome,
          runWithIntent: (intent, action, toOutcome) =>
            // Wrap the caller-provided action so we can count how many times it fires, and
            // assert that at the moment the action fires the corresponding intent is already
            // in the recording (proving strict ordering).
            recording.service.runWithIntent(
              intent,
              (ack) =>
                Effect.gen(function* () {
                  const intentsBefore = yield* recording.intents()
                  const matched = intentsBefore.some(
                    (event) => event.correlationId === intent.correlationId,
                  )
                  expect(matched).toBe(true)
                  yield* Ref.update(actionCounter, (count) => count + 1)
                  return yield* action(ack)
                }),
              toOutcome,
            ),
        }
        for (let i = 0; i < DEFAULT_DX_ITERATIONS; i += 1) {
          const area = DX_AREA_CATALOG[i % DX_AREA_CATALOG.length]!
          yield* runIterationThroughBus(measuredBus, area, i + 1, snapshot)
        }
        const intents = yield* recording.intents()
        const outcomes = yield* recording.outcomes()
        const actions = yield* Ref.get(actionCounter)
        return {intents, outcomes, actions}
      }),
    )
    expect(result.actions).toBe(DEFAULT_DX_ITERATIONS)
    expect(result.intents).toHaveLength(DEFAULT_DX_ITERATIONS)
    expect(result.outcomes).toHaveLength(DEFAULT_DX_ITERATIONS)
    // Ordering: iteration N's intent precedes iteration N's outcome.
    for (let i = 0; i < DEFAULT_DX_ITERATIONS; i += 1) {
      expect(result.intents[i]?.iteration).toBe(i + 1)
      expect(result.outcomes[i]?.correlationId).toBe(result.intents[i]?.correlationId)
    }
  })

  it('never runs the measurement action when recordIntent fails — outcome-bias prevention on the DX side', async () => {
    const snapshot = await loadRealSnapshot()
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const intentCallCounter = yield* Ref.make(0)
        const bus = yield* makeIntentFailingBus(intentCallCounter)
        const actionCounter = yield* Ref.make(0)
        // Splice the counter into the action: if runWithIntent's action closure ever fires, the
        // counter increments. It MUST stay at zero.
        const area = DX_AREA_CATALOG[0]!
        const wrappedBus: AgentBusService = {
          recordIntent: bus.recordIntent,
          recordOutcome: bus.recordOutcome,
          runWithIntent: (intent, action, toOutcome) =>
            bus.runWithIntent(
              intent,
              (ack) =>
                Ref.update(actionCounter, (count) => count + 1).pipe(Effect.andThen(action(ack))),
              toOutcome,
            ),
        }
        const exit = yield* Effect.exit(runIterationThroughBus(wrappedBus, area, 1, snapshot))
        const actions = yield* Ref.get(actionCounter)
        return {exit, actions}
      }),
    )
    expect(Exit.isFailure(outcome.exit)).toBe(true)
    expect(outcome.actions).toBe(0)
  })

  it('records exactly N intent/outcome pairs when the caller requests N iterations (--iterations parity)', async () => {
    const snapshot = await loadRealSnapshot()
    for (const iterations of [1, 3, 8, DX_AREA_CATALOG.length, DX_AREA_CATALOG.length + 3]) {
      const events = await Effect.runPromise(
        Effect.gen(function* () {
          const recording = yield* makeRecordingAgentBus()
          const visited = rotateAreas(iterations, DX_AREA_CATALOG)
          for (let i = 0; i < visited.length; i += 1) {
            const area = DX_AREA_CATALOG[i % DX_AREA_CATALOG.length]!
            yield* runIterationThroughBus(recording.service, area, i + 1, snapshot)
          }
          const intents = yield* recording.intents()
          const outcomes = yield* recording.outcomes()
          return {intents, outcomes}
        }),
      )
      expect(events.intents, `intents count for iterations=${iterations}`).toHaveLength(iterations)
      expect(events.outcomes, `outcomes count for iterations=${iterations}`).toHaveLength(
        iterations,
      )
    }
  })

  it('assigns degree in [0, 1] and a Desirability tag for every catalog entry', async () => {
    const snapshot = await loadRealSnapshot()
    for (const area of DX_AREA_CATALOG) {
      const {desirability, degree} = classifyDxAreaOutcome(area, snapshot)
      expect(['desirable', 'neutral', 'undesirable']).toContain(desirability)
      expect(degree).toBeGreaterThanOrEqual(0)
      expect(degree).toBeLessThanOrEqual(1)
    }
  })

  it('degrades to `undesirable`/0 when the git-hooks area regresses to fail-open — proving the classifier is falsifiable, not rubber-stamping', () => {
    const badSnapshot: SignalSnapshot = {
      scriptCount: 30,
      documentedRatio: {documented: 30, total: 30, ratio: 1},
      hookStatus: 'fail-open',
      prettierConfigCount: 1,
      danglingTurbo: [],
    }
    const gitHooks = DX_AREA_CATALOG.find((area) => area.id === 'git-hooks')!
    const outcome = classifyDxAreaOutcome(gitHooks, badSnapshot)
    expect(outcome.desirability).toBe('undesirable')
    expect(outcome.degree).toBe(0)
  })

  it('degrades to `undesirable` when documentation regresses below the predicted floor', () => {
    const badSnapshot: SignalSnapshot = {
      scriptCount: 30,
      documentedRatio: {documented: 15, total: 30, ratio: 0.5},
      hookStatus: 'enforced',
      prettierConfigCount: 1,
      danglingTurbo: [],
    }
    const documentation = DX_AREA_CATALOG.find((area) => area.id === 'documentation')!
    const outcome = classifyDxAreaOutcome(documentation, badSnapshot)
    expect(outcome.desirability).toBe('undesirable')
    expect(outcome.degree).toBeLessThan(0.5)
  })

  it('routes DX events to a run-scoped file under reports/agent-bus/optimize-dx/cli-contributor-engineer/ and nothing under reports/agent-bus/ is git-tracked', async () => {
    // The intent/outcome pair we build for area[0] iteration 1 must resolve to the DX-only path.
    const area = DX_AREA_CATALOG[0]!
    const intent = buildIntent(area, 1)
    expect(intent.skill).toBe('optimize-dx')
    expect(intent.personaId).toBe('cli-contributor-engineer')
    // Live layer routes to baseDir + skill + personaId + `${runId}.jsonl`. The DX driver wires
    // baseDir = REPO_ROOT/reports/agent-bus, so a fresh run always writes into a fresh file under
    // this directory (never colliding with any prior run's on-disk state):
    const expectedDir = path
      .join('reports', 'agent-bus', intent.skill, intent.personaId)
      .replace(/\\/g, '/')
    expect(expectedDir).toBe('reports/agent-bus/optimize-dx/cli-contributor-engineer')

    // Git-tracked verification: read .gitignore and confirm `reports/` is ignored (the whole
    // subtree therefore is), and confirm no explicit exception re-includes agent-bus files.
    const gitignore = await readFile(path.join(REPO_ROOT, '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/^reports\/\s*$/m)
    expect(gitignore).not.toMatch(/^!reports\/agent-bus/m)
  })

  // ---------------------------------------------------------------------------------------------
  // Theo's DevEx-authored non-success `toOutcome` branches. The bus never synthesises a generic
  // "no comparison available" payload — the DX caller now authors distinguishable persona prose
  // for typed-failure, defect, and interrupt. These tests capture the caller's `toOutcome`
  // closure via a probing bus, invoke it against each synthesised `Exit` shape, and assert:
  //   1. No branch still contains the compile-only `PLACEHOLDER-THEO-TO-REPLACE` stub.
  //   2. The three non-success branches produce DISTINGUISHABLE actualResult and delta text
  //      (no shared boilerplate across shapes).
  //   3. Each branch's judgment (desirability/degree/observedFriction) is shape-appropriate.
  // ---------------------------------------------------------------------------------------------
  describe("Theo's DevEx-authored non-success toOutcome branches", () => {
    // Build a probing bus that captures the `toOutcome` closure and lets a test invoke it
    // against a synthesised Exit. The action closure is not executed on this path — we only
    // exercise the caller-authored terminal outcome authoring.
    async function captureToOutcomeFor(area: DxArea, iteration: number, snapshot: SignalSnapshot) {
      return Effect.runPromise(
        Effect.gen(function* () {
          let captured: ToOutcome<string, unknown> | undefined
          const probingBus: AgentBusService = {
            recordIntent: () => Effect.die('recordIntent should not run in this probe'),
            recordOutcome: () => Effect.die('recordOutcome should not run in this probe'),
            runWithIntent: <A, E, R>(
              _intent: IntentInput,
              _action: (ack: IntentAck) => Effect.Effect<A, E, R>,
              toOutcome: ToOutcome<A, E>,
            ): Effect.Effect<A, E | AgentBusFailure, R> => {
              captured = toOutcome as unknown as ToOutcome<string, unknown>
              return Effect.void as unknown as Effect.Effect<A, E | AgentBusFailure, R>
            },
          }
          yield* runIterationThroughBus(probingBus, area, iteration, snapshot)
          if (!captured) throw new Error('probe never received toOutcome closure')
          return captured
        }),
      )
    }

    // Synthetic ack + intent snapshot are shape-only — the closure only reads `intent.iteration`.
    const fakeAck: IntentAck = {
      correlationId: 'optimize-dx:cli-contributor-engineer:7:documentation',
      runId: 'test-run',
      recordedAt: '2026-07-30T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const fakeIntentSnapshot = {
      correlationId: 'optimize-dx:cli-contributor-engineer:7:documentation',
      runId: 'test-run',
      personaId: 'cli-contributor-engineer',
      domain: 'developer' as const,
      skill: 'optimize-dx',
      iteration: 7,
      perceivedInterface: '',
      intendedAction: '',
      expectedResult: '',
      recordedAt: '2026-07-30T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const healthySnapshot: SignalSnapshot = {
      scriptCount: 30,
      documentedRatio: {documented: 27, total: 30, ratio: 0.9},
      hookStatus: 'enforced',
      prettierConfigCount: 1,
      danglingTurbo: [],
    }

    it('typed-failure branch: distinguishable, non-placeholder, undesirable at low degree', async () => {
      const area = DX_AREA_CATALOG.find((a) => a.id === 'documentation')!
      const toOutcome = await captureToOutcomeFor(area, 7, healthySnapshot)
      const payload = toOutcome(
        Exit.fail(new Error('simulated typed failure')) as Exit.Exit<string, unknown>,
        fakeAck,
        fakeIntentSnapshot,
      )
      expect(payload.actualResult).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
      expect(payload.delta).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
      expect(payload.actualResult).toMatch(/typed failure/i)
      expect(payload.actualResult).toContain(area.id)
      expect(payload.actualResult).toContain('iteration 7')
      expect(payload.desirability).toBe('undesirable')
      expect(payload.degree).toBeGreaterThan(0)
      expect(payload.degree).toBeLessThan(0.5)
      expect(payload.observedFriction).toBe(`dx-signal-read-failed:${area.id}`)
    })

    it('defect branch: distinguishable, non-placeholder, undesirable at floor (own-tool bug)', async () => {
      const area = DX_AREA_CATALOG.find((a) => a.id === 'git-hooks')!
      const toOutcome = await captureToOutcomeFor(area, 4, healthySnapshot)
      const payload = toOutcome(
        Exit.die(new Error('simulated unmodelled crash')) as Exit.Exit<string, unknown>,
        fakeAck,
        {...fakeIntentSnapshot, iteration: 4},
      )
      expect(payload.actualResult).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
      expect(payload.delta).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
      expect(payload.actualResult).toMatch(/defect/i)
      expect(payload.actualResult).toContain(area.id)
      expect(payload.actualResult).toContain('iteration 4')
      expect(payload.delta).toMatch(/invariant hole|tool meant to reduce/i)
      expect(payload.desirability).toBe('undesirable')
      expect(payload.degree).toBe(0)
      expect(payload.observedFriction).toBe(`dx-tool-defect:${area.id}`)
    })

    it('interrupt branch: distinguishable, non-placeholder, neutral (we never got there)', async () => {
      const area = DX_AREA_CATALOG.find((a) => a.id === 'developer-tools')!
      const toOutcome = await captureToOutcomeFor(area, 2, healthySnapshot)
      const payload = toOutcome(
        Exit.failCause(Cause.interrupt(0 as never)) as Exit.Exit<string, unknown>,
        fakeAck,
        {...fakeIntentSnapshot, iteration: 2},
      )
      expect(payload.actualResult).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
      expect(payload.delta).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
      expect(payload.actualResult).toMatch(/interrupt|cancelled/i)
      expect(payload.actualResult).toContain(area.id)
      expect(payload.actualResult).toContain('iteration 2')
      expect(payload.desirability).toBe('neutral')
      expect(payload.degree).toBe(0.5)
      expect(payload.observedFriction).toBe(`interrupt-before-observation:${area.id}`)
    })

    it('the three non-success shapes produce fully distinguishable text (no shared boilerplate)', async () => {
      const area = DX_AREA_CATALOG.find((a) => a.id === 'documentation')!
      const toOutcome = await captureToOutcomeFor(area, 1, healthySnapshot)
      const typedFailure = toOutcome(
        Exit.fail(new Error('typed')) as Exit.Exit<string, unknown>,
        fakeAck,
        {...fakeIntentSnapshot, iteration: 1},
      )
      const defect = toOutcome(
        Exit.die(new Error('defect')) as Exit.Exit<string, unknown>,
        fakeAck,
        {...fakeIntentSnapshot, iteration: 1},
      )
      const interrupted = toOutcome(
        Exit.failCause(Cause.interrupt(0 as never)) as Exit.Exit<string, unknown>,
        fakeAck,
        {...fakeIntentSnapshot, iteration: 1},
      )
      const actualResults = new Set([
        typedFailure.actualResult,
        defect.actualResult,
        interrupted.actualResult,
      ])
      const deltas = new Set([typedFailure.delta, defect.delta, interrupted.delta])
      const frictions = new Set([
        typedFailure.observedFriction,
        defect.observedFriction,
        interrupted.observedFriction,
      ])
      expect(actualResults.size).toBe(3)
      expect(deltas.size).toBe(3)
      expect(frictions.size).toBe(3)
      // And none of them should match the success-path shape either — success uses classifier
      // deltas that reference concrete signal names, not the DX-tool-failure language above.
      const successish = toOutcome(
        Exit.succeed('any observation string') as Exit.Exit<string, unknown>,
        fakeAck,
        {...fakeIntentSnapshot, iteration: 1},
      )
      expect(successish.actualResult).toBe('any observation string')
      expect(successish.actualResult).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
    })

    it('the checked-in optimize-dx.ts source contains NO PLACEHOLDER-THEO-TO-REPLACE token', async () => {
      // Belt-and-braces guard against a future refactor accidentally re-introducing the stub.
      const source = await readFile(
        path.join(REPO_ROOT, 'skills', 'optimize-dx', 'scripts', 'optimize-dx.ts'),
        'utf8',
      )
      expect(source).not.toContain('PLACEHOLDER-THEO-TO-REPLACE')
    })
  })
})
