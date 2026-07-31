import {Effect, Either, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import Auth from '../../../src/commands/auth.js'
import Migrate from '../../../src/commands/migrate.js'
import Sessions from '../../../src/commands/sessions.js'
import {AgentBusTestLayer} from '../../../src/experience/agent-bus.js'
import {
  decodeExperimentConfig,
  DEFAULT_PERSONA_ITERATIONS,
  DESIGN_ALTERNATIVES,
  evaluateIteration,
  ExperimentArtifactWriterTag,
  EXPERIMENT_BASELINES,
  initialDesign,
  optimizeDesign,
  PERSONAS,
  rankLevers,
  renderExperimentReport,
  renderTraceJsonl,
  runPersonaExperiment,
  ScenarioRunnerTag,
  validateTraceJsonl,
  type DesignState,
  type ScenarioObservation,
} from '../../../src/experience/persona-experiment.js'
import {
  buildCliCoverageReport,
  CLI_COVERAGE_MANIFEST,
  CLI_JOURNEYS,
  cliJourneyObservations,
} from '../../../src/experience/cli-journeys.js'

const observation: ScenarioObservation = {
  feature: 'Safe migration orchestration',
  scenario: 'Rejected team creation fails before any target write',
  status: 'passed',
  durationMs: 120,
  steps: [
    'the operator rejects team creation',
    'the migration is applied',
    'the migration fails with "Destructive team creation not approved"',
    'no GitHub writes are attempted',
    'the rejection is retained in the checkpoint',
  ],
}

describe('persona experiment', () => {
  it('keeps the legacy synthetic baseline while modeling partial CLI-wide production levers honestly', () => {
    expect(initialDesign().levers).toEqual(EXPERIMENT_BASELINES.synthetic.levers)
    expect(initialDesign('production').levers).toEqual(EXPERIMENT_BASELINES.production.levers)
    expect(
      Object.entries(EXPERIMENT_BASELINES.production.levers)
        .filter(([lever]) =>
          [
            'statusVisibility',
            'plainLanguage',
            'recoveryGuidance',
            'approvalContext',
            'adaptiveDetail',
            'confirmationClosure',
          ].includes(lever),
        )
        .every(([, value]) => value === 1),
    ).toBe(true)
    expect(EXPERIMENT_BASELINES.production.levers.automationClarity).toBe(1)
    expect(EXPERIMENT_BASELINES.production.levers.credentialSetup).toBe(1)
    expect(EXPERIMENT_BASELINES.production.levers.commandDiscoverability).toBe(1)
    expect(EXPERIMENT_BASELINES.production.levers.flagErgonomics).toBe(1)
    expect(EXPERIMENT_BASELINES.production.levers.scopeRepetition).toBeLessThan(1)
    expect(EXPERIMENT_BASELINES.production.levers.errorPrevention).toBe(1)
    expect(EXPERIMENT_BASELINES.production.implementedAlternativeIds).toEqual(
      DESIGN_ALTERNATIVES.filter((alternative) =>
        [
          'statusVisibility',
          'plainLanguage',
          'recoveryGuidance',
          'approvalContext',
          'adaptiveDetail',
          'confirmationClosure',
          'commandDiscoverability',
          'flagErgonomics',
          'errorPrevention',
          'automationClarity',
          'credentialSetup',
        ].includes(alternative.lever),
      ).map((alternative) => alternative.id),
    )
  })

  it('models eleven contrasting personas with complete operator CLI journey representation', () => {
    // Full Squad roster is 11 personas (10 operators + 1 developer/contributor). This assertion is
    // deliberately kept alongside the operator-scoped coverage assertion below so it is obvious
    // which count is "full Squad roster" versus "operator CLI coverage."
    expect(PERSONAS).toHaveLength(11)
    expect(PERSONAS.map((persona) => persona.id)).toEqual(
      expect.arrayContaining([
        'unattended-automation-engineer',
        'security-credential-administrator',
        'incident-recovery-operator',
        'infrequent-low-bandwidth-operator',
        'advanced-agentic-tui-operator',
        'enterprise-tui-designer',
        'cli-contributor-engineer',
      ]),
    )
    expect(
      PERSONAS.every(
        (persona) =>
          persona.goal.length > 0 &&
          persona.context.length > 0 &&
          persona.accessNeeds.length > 0 &&
          Object.keys(persona.sensitivities).length === 12,
      ),
    ).toBe(true)
  })

  it('partitions personas into ten operators and one developer/contributor by domain', () => {
    const operators = PERSONAS.filter((persona) => persona.domain === 'operator')
    const developers = PERSONAS.filter((persona) => persona.domain === 'developer')
    expect(operators).toHaveLength(10)
    expect(developers).toHaveLength(1)
    expect(developers[0]?.id).toBe('cli-contributor-engineer')
  })

  it('enforces complete operator CLI command, flag, entrypoint, conflict, and persona coverage', () => {
    // Operator CLI coverage is scoped to the 10 operator personas only. The developer/contributor
    // persona (Theo) does not participate in the operator CLI experiment and must not appear in
    // any CLI_JOURNEYS persona list.
    const operatorPersonaIds = PERSONAS.filter((persona) => persona.domain === 'operator').map(
      (persona) => persona.id,
    )
    const coverage = buildCliCoverageReport(CLI_JOURNEYS, operatorPersonaIds)

    expect(coverage).toMatchObject({
      commandCount: 3,
      coveredCommandCount: 3,
      flagCount: 32,
      coveredFlagCount: 32,
      entrypointCount: 6,
      coveredEntrypointCount: 6,
      conflictCount: 12,
      coveredConflictCount: 12,
      personaCount: 10,
      coveredPersonaCount: 10,
      failures: [],
    })
    expect(CLI_COVERAGE_MANIFEST.commands.map(({command}) => command)).toEqual([
      'migrate',
      'auth',
      'sessions',
    ])
    expect(
      Object.fromEntries(
        CLI_COVERAGE_MANIFEST.commands.map(({command, flags}) => [
          command,
          flags.map((flag) => flag.slice(2)).sort(),
        ]),
      ),
    ).toEqual({
      migrate: Object.entries(Migrate.flags)
        .flatMap(([name, flag]) => [name, ...(flag.aliases ?? [])])
        .sort(),
      auth: Object.entries(Auth.flags)
        .flatMap(([name, flag]) => [name, ...(flag.aliases ?? [])])
        .sort(),
      sessions: Object.entries(Sessions.flags)
        .flatMap(([name, flag]) => [name, ...(flag.aliases ?? [])])
        .sort(),
    })

    const incomplete = buildCliCoverageReport(
      CLI_JOURNEYS.filter((journey) => !journey.flags.includes('--quiet')),
      operatorPersonaIds,
    )
    expect(incomplete.failures).toContain('auth flag --quiet has no persona journey')
    expect(CLI_JOURNEYS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'validate-credential-readiness-json',
          command: 'auth',
          flags: ['--ado-org', '--json'],
          personas: ['unattended-automation-engineer', 'security-credential-administrator'],
          steps: expect.arrayContaining([
            expect.objectContaining({lever: 'credentialSetup'}),
            expect.objectContaining({lever: 'automationClarity'}),
          ]),
        }),
      ]),
    )
  })

  it('never leaks the contributor developer persona into operator CLI journeys', () => {
    // Structural regression guard: the isolation is not just convention — no operator CLI journey
    // may list the contributor persona in its `personas` array. If this fails, DevEx coupling has
    // been re-introduced and must be undone.
    for (const journey of CLI_JOURNEYS) {
      expect(
        journey.personas,
        `journey ${journey.id} must not include cli-contributor-engineer`,
      ).not.toContain('cli-contributor-engineer')
    }
  })

  it('rejects an unsupported baseline through the typed configuration failure path', () => {
    const decoded = Effect.runSync(
      Effect.either(
        decodeExperimentConfig({
          baseline: 'stale',
          iterations: 3,
          optimizationStep: 0.2,
          painThreshold: 40,
        }),
      ),
    )

    expect(Either.isLeft(decoded)).toBe(true)
    if (Either.isLeft(decoded)) {
      expect(decoded.left).toMatchObject({
        _tag: 'ExperimentConfigurationFailure',
        message: 'Experiment configuration is malformed',
      })
    }
  })

  it('logs every rendered action and persona thought', () => {
    const iteration = evaluateIteration(initialDesign(), PERSONAS, [observation], 40)

    expect(iteration.traces).toHaveLength(PERSONAS.length * observation.steps.length)
    expect(iteration.traces.every((trace) => trace.thought.length > 0)).toBe(true)
    expect(iteration.traces.every((trace) => trace.whyPainful.length > 0)).toBe(true)
    expect(iteration.metrics.actionCount).toBe(iteration.traces.length)
  })

  it('reduces measured friction when the relevant design lever improves', () => {
    const baseline = evaluateIteration(initialDesign(), PERSONAS, [observation], 40)
    const improvedDesign: DesignState = {
      iteration: 2,
      levers: {...initialDesign().levers, recoveryGuidance: 1},
    }
    const improved = evaluateIteration(improvedDesign, PERSONAS, [observation], 40)
    const baselineRecovery = baseline.traces
      .filter((trace) => trace.lever === 'recoveryGuidance')
      .reduce((total, trace) => total + trace.frictionScore, 0)
    const improvedRecovery = improved.traces
      .filter((trace) => trace.lever === 'recoveryGuidance')
      .reduce((total, trace) => total + trace.frictionScore, 0)

    expect(improvedRecovery).toBeLessThan(baselineRecovery)
  })

  it('reduces aggregate friction from the synthetic baseline to the production baseline', () => {
    const scenarios = [...cliJourneyObservations(), observation]
    const synthetic = evaluateIteration(initialDesign('synthetic'), PERSONAS, scenarios, 40)
    const production = evaluateIteration(initialDesign('production'), PERSONAS, scenarios, 40)

    expect(production.metrics.meanFriction).toBeLessThan(synthetic.metrics.meanFriction)
    expect(production.metrics.p95Friction).toBeLessThan(synthetic.metrics.p95Friction)
  })

  it('ranks only the remaining scope-repetition lever as a production candidate', () => {
    const iteration = evaluateIteration(
      initialDesign('production'),
      PERSONAS,
      cliJourneyObservations(),
      40,
    )
    const ranking = rankLevers(iteration)

    expect(ranking.map(({lever}) => lever)).toEqual(['scopeRepetition'])
    expect(ranking.map(({rank}) => rank)).toEqual([1])
    expect(ranking.every(({traceCount}) => traceCount > 0)).toBe(true)
  })

  it('reports a truthful no-candidate convergence decision', () => {
    const fullyImplemented: DesignState = {
      iteration: 9,
      levers: {
        statusVisibility: 1,
        plainLanguage: 1,
        recoveryGuidance: 1,
        approvalContext: 1,
        adaptiveDetail: 1,
        confirmationClosure: 1,
        commandDiscoverability: 1,
        flagErgonomics: 1,
        scopeRepetition: 1,
        automationClarity: 1,
        credentialSetup: 1,
        errorPrevention: 1,
      },
    }
    const iteration = evaluateIteration(fullyImplemented, PERSONAS, cliJourneyObservations(), 40)
    const optimized = optimizeDesign(iteration, 0.2)

    expect(rankLevers(iteration)).toEqual([])
    expect(optimized.decision).toBeNull()
    expect(optimized.note?.rationale).toContain('no further modeled optimization')
  })

  it('changes exactly one lever toward the largest remaining pain opportunity', () => {
    const baseline = evaluateIteration(initialDesign(), PERSONAS, [observation], 40)
    const optimized = optimizeDesign(baseline, 0.2)
    const changed = Object.keys(baseline.design.levers).filter(
      (lever) =>
        baseline.design.levers[lever as keyof typeof baseline.design.levers] !==
        optimized.design.levers[lever as keyof typeof optimized.design.levers],
    )

    expect(optimized.decision).not.toBeNull()
    if (!optimized.decision) {
      throw new Error('Expected a synthetic-baseline optimization decision')
    }
    expect(changed).toEqual([optimized.decision.lever])
    expect(optimized.decision.lever).toBe('recoveryGuidance')
    expect(optimized.decision.nextValue).toBeGreaterThan(optimized.decision.previousValue)
    expect(optimized.note).toBeNull()
    expect(optimized.design.iteration).toBe(2)
  })

  it('runs the bounded eight-iteration production experiment and reports non-convergence truthfully', async () => {
    const result = await Effect.runPromise(
      runPersonaExperiment({
        baseline: 'production',
        iterations: DEFAULT_PERSONA_ITERATIONS,
        optimizationStep: 0.2,
        painThreshold: 40,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ScenarioRunnerTag, {
              run: () => Effect.succeed([observation]),
            }),
            Layer.succeed(ExperimentArtifactWriterTag, {
              write: () => Effect.void,
            }),
            AgentBusTestLayer,
          ),
        ),
      ),
    )

    expect(result.iterations.map((iteration) => iteration.design.iteration)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
    expect(result.optimizationDecisions).toHaveLength(3)
    expect(result.optimizationNotes).toHaveLength(4)
    expect(result.completion).toEqual({
      requestedIterations: 8,
      completedIterations: 8,
      converged: true,
      reason: 'converged-no-candidate',
      remainingCandidateCount: 0,
    })
    expect(result.iterations[0]?.metrics).toMatchObject({
      migrationScenarioCount: 1,
      cliJourneyCount: CLI_JOURNEYS.length,
    })
    expect(renderExperimentReport(result)).toContain(
      'Identity: `production` (Current production experience)',
    )
    expect(renderExperimentReport(result)).toContain('Declared flags: 32/32')
    const traceJsonl = renderTraceJsonl(result)
    expect(JSON.parse(traceJsonl.split('\n')[0] ?? '{}')).toMatchObject({
      baselineId: 'production',
      baselineSource: 'Current production implementation',
      scenarioSource: 'migration-bdd',
      journeyId: null,
    })
    expect(traceJsonl).toContain('"scenarioSource":"cli-journey"')
    expect(traceJsonl).toContain('"command":"migrate"')
    expect(validateTraceJsonl(traceJsonl).malformedLineCount).toBe(0)
    const malformedTrace: Record<string, unknown> = JSON.parse(traceJsonl.split('\n')[0] ?? '{}')
    malformedTrace.journeyId = 123
    expect(validateTraceJsonl(JSON.stringify(malformedTrace)).malformedLineCount).toBe(1)
  })

  it('rejects malformed or shape-inexact JSONL traces', () => {
    expect(validateTraceJsonl('{"iteration":1}')).toMatchObject({
      lineCount: 1,
      validLineCount: 0,
      malformedLineCount: 1,
    })
    expect(validateTraceJsonl('not-json').failures).toEqual(['Line 1 is not valid JSON'])
  })
})
