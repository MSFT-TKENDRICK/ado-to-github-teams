import {Effect, Either, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  decodeExperimentConfig,
  DESIGN_ALTERNATIVES,
  evaluateIteration,
  ExperimentArtifactWriterTag,
  EXPERIMENT_BASELINES,
  initialDesign,
  optimizeDesign,
  PERSONAS,
  renderExperimentReport,
  renderTraceJsonl,
  runPersonaExperiment,
  ScenarioRunnerTag,
  type DesignState,
  type ScenarioObservation,
} from '../../../src/experience/persona-experiment.js'

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
  it('keeps the legacy synthetic baseline while modeling the current production design explicitly', () => {
    expect(initialDesign().levers).toEqual(EXPERIMENT_BASELINES.synthetic.levers)
    expect(initialDesign('production').levers).toEqual(EXPERIMENT_BASELINES.production.levers)
    expect(
      Object.values(EXPERIMENT_BASELINES.production.levers).every((value) => value === 1),
    ).toBe(true)
    expect(EXPERIMENT_BASELINES.production.implementedAlternativeIds).toEqual(
      DESIGN_ALTERNATIVES.map((alternative) => alternative.id),
    )
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
    const synthetic = evaluateIteration(initialDesign('synthetic'), PERSONAS, [observation], 40)
    const production = evaluateIteration(initialDesign('production'), PERSONAS, [observation], 40)

    expect(production.metrics.meanFriction).toBeLessThan(synthetic.metrics.meanFriction)
    expect(production.metrics.p95Friction).toBeLessThan(synthetic.metrics.p95Friction)
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

  it('runs every production iteration without inventing optimization decisions', async () => {
    const result = await Effect.runPromise(
      runPersonaExperiment({
        baseline: 'production',
        iterations: 3,
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
          ),
        ),
      ),
    )

    expect(result.iterations.map((iteration) => iteration.design.iteration)).toEqual([1, 2, 3])
    expect(result.optimizationDecisions).toEqual([])
    expect(result.optimizationNotes).toHaveLength(2)
    expect(result.optimizationNotes.every((note) => note.rationale.includes('no further'))).toBe(
      true,
    )
    expect(result.iterations.map((iteration) => iteration.design.levers)).toEqual([
      EXPERIMENT_BASELINES.production.levers,
      EXPERIMENT_BASELINES.production.levers,
      EXPERIMENT_BASELINES.production.levers,
    ])
    expect(renderExperimentReport(result)).toContain(
      'Identity: `production` (Current production experience)',
    )
    expect(JSON.parse(renderTraceJsonl(result).split('\n')[0] ?? '{}')).toMatchObject({
      baselineId: 'production',
      baselineSource: 'Current production implementation',
    })
  })
})
