import {describe, expect, it} from 'vitest'
import {
  evaluateIteration,
  initialDesign,
  optimizeDesign,
  PERSONAS,
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

  it('changes exactly one lever toward the largest remaining pain opportunity', () => {
    const baseline = evaluateIteration(initialDesign(), PERSONAS, [observation], 40)
    const optimized = optimizeDesign(baseline, 0.2)
    const changed = Object.keys(baseline.design.levers).filter(
      (lever) =>
        baseline.design.levers[lever as keyof typeof baseline.design.levers] !==
        optimized.design.levers[lever as keyof typeof optimized.design.levers],
    )

    expect(changed).toEqual([optimized.decision.lever])
    expect(optimized.decision.lever).toBe('recoveryGuidance')
    expect(optimized.decision.nextValue).toBeGreaterThan(optimized.decision.previousValue)
    expect(optimized.design.iteration).toBe(2)
  })
})
