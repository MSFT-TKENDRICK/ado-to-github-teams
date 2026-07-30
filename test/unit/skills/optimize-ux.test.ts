import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {
  renderExperimentReport,
  renderTraceJsonl,
  type ScenarioObservation,
} from '../../../src/experience/persona-experiment.js'
import {
  buildExpectedReport,
  compareMetrics,
  decodeCheckpoint,
  decideConvergence,
  emptyCheckpoint,
  nextLoopCounters,
  rankUnaddressedCandidates,
  selectCandidates,
  validateExperimentEvidence,
  type CandidateEvidence,
  type MetricSnapshot,
} from '../../../skills/optimize-ux/scripts/core.js'
import {
  parseCucumberJsonl,
  productionDiffText,
  renderHelp,
  resolveIterationCount,
  validateCommandArguments,
  validateDocumentationContent,
} from '../../../skills/optimize-ux/scripts/optimize-ux.js'

const observation: ScenarioObservation = {
  feature: 'Safe migration orchestration',
  scenario: 'Show a recoverable error',
  status: 'passed',
  durationMs: 100,
  steps: ['discover the command', 'validate credentials', 'resolve conflicting flags'],
}

const config = {
  baseline: 'production' as const,
  iterations: 2,
  optimizationStep: 0.2,
  painThreshold: 40,
}

function validEvidence() {
  const cucumberIterations = [[observation], [observation]]
  const report = buildExpectedReport(config, cucumberIterations)
  return {
    input: {
      report,
      traceJsonl: `${renderTraceJsonl(report)}\n`,
      coverage: report.cliCoverage,
      markdown: renderExperimentReport(report),
      config,
      cucumberIterations,
      cucumberRecordCount: 24,
    },
    report,
  }
}

function candidate(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    lever: 'credentialSetup',
    alternativeId: 'credential-readiness-preflight',
    highHarmActions: 0,
    p95Friction: 45,
    unintuitiveActions: 2,
    meanFriction: 22,
    traceCount: 10,
    observedOpportunity: 30,
    aboveThreshold: true,
    representedBy: [],
    ...overrides,
  }
}

const metrics: MetricSnapshot = {
  meanFriction: 18,
  p95Friction: 40,
  unintuitiveActions: 5,
  highHarmActions: 0,
}

describe('persona UX artifact validation', () => {
  it('exactly recomputes every configured iteration and links the trace multiset', () => {
    const {input} = validEvidence()
    expect(validateExperimentEvidence(input).summary).toEqual({
      valid: true,
      configuredIterations: 2,
      cucumberIterationCount: 2,
      cucumberRecordCount: 24,
      traceLineCount: expect.any(Number),
      validTraceLineCount: expect.any(Number),
      malformedTraceLineCount: 0,
      missingRecordCount: 0,
      unexpectedRecordCount: 0,
      failures: [],
    })
  })

  it('fails closed on malformed and unexpected Cucumber envelopes', () => {
    const parsed = parseCucumberJsonl('{"unexpected":{}}\nnot-json\n', 1)
    expect(parsed.recordCount).toBe(2)
    expect(parsed.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unexpected envelope'),
        expect.stringContaining('is malformed'),
        expect.stringContaining('no scenario observations'),
      ]),
    )
  })

  it('accepts reordered JSONL but rejects missing, unexpected, malformed, and stale report records', () => {
    const {input} = validEvidence()
    const lines = input.traceJsonl.trim().split('\n')
    const reordered = validateExperimentEvidence({
      ...input,
      traceJsonl: `${lines.reverse().join('\n')}\n`,
    })
    expect(reordered.summary.valid).toBe(true)

    const malformed = validateExperimentEvidence({
      ...input,
      report: {...(input.report as object), unexpected: true},
      traceJsonl: `${lines.slice(1).join('\n')}\nnot-json\n`,
    })
    expect(malformed.summary.valid).toBe(false)
    expect(malformed.summary.missingRecordCount).toBe(1)
    expect(malformed.summary.malformedTraceLineCount).toBe(1)
    expect(malformed.summary.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unexpected key unexpected'),
        expect.stringContaining('missing 1 normalized report records'),
      ]),
    )
  })

  it('ranks only unaddressed production friction in harm-first order', () => {
    const {report} = validEvidence()
    const all = rankUnaddressedCandidates(report, new Set(), new Map(), 40)
    const addressed = rankUnaddressedCandidates(
      report,
      new Set([all[0]?.lever ?? 'credentialSetup']),
      new Map(),
      40,
    )
    expect(all.length).toBeGreaterThan(0)
    expect(addressed).toHaveLength(all.length - 1)
    expect(all).toEqual(
      [...all].sort(
        (left, right) =>
          right.highHarmActions - left.highHarmActions ||
          right.p95Friction - left.p95Friction ||
          right.unintuitiveActions - left.unintuitiveActions ||
          left.lever.localeCompare(right.lever),
      ),
    )
  })
})

describe('persona UX planning and convergence', () => {
  it('selects one to ten fixes without exceeding the six-point budget', () => {
    const candidates = [
      candidate({lever: 'credentialSetup'}),
      candidate({lever: 'commandDiscoverability'}),
      candidate({lever: 'flagErgonomics'}),
    ]
    const plan = selectCandidates(candidates, {
      credentialSetup: 'large',
      commandDiscoverability: 'small',
      flagErgonomics: 'small',
    })
    expect(plan.pointsUsed).toBe(6)
    expect(plan.selected.map(({lever}) => lever)).toEqual([
      'credentialSetup',
      'commandDiscoverability',
    ])
    expect(plan.deferred.map(({lever}) => lever)).toEqual(['flagErgonomics'])
  })

  it('blocks high-harm regressions and unexplained no-change results', () => {
    expect(
      compareMetrics(metrics, {...metrics, highHarmActions: 1, p95Friction: 20}, null),
    ).toMatchObject({blocking: true, reason: 'high-harm-actions-regressed'})
    expect(compareMetrics(metrics, metrics, null)).toMatchObject({
      blocking: true,
      reason: 'no-measurable-improvement-without-explanation',
    })
    expect(compareMetrics(metrics, metrics, 'Covered by a focused prevention test')).toMatchObject({
      blocking: false,
      improved: false,
    })
  })

  it('does not treat iteration-bound exhaustion as convergence while candidates remain', () => {
    expect(
      decideConvergence({
        evidenceValid: true,
        docsFresh: true,
        reportBoundExhausted: true,
        candidates: [candidate()],
        previousMetrics: null,
        latestMetrics: metrics,
        noChangeReason: null,
        repeatedCandidateCycles: 0,
        noProgressCycles: 0,
        freshRerun: false,
        userStopped: false,
        realBlocker: null,
        adversarialVerdict: 'passed',
        minimumOpportunity: 1,
      }),
    ).toMatchObject({
      status: 'continue',
      reason: 'bound-exhausted-with-ranked-candidates',
      boundExhausted: true,
    })
  })

  it('converges only after threshold clearance or confirmed insufficient opportunity', () => {
    const base = {
      evidenceValid: true,
      docsFresh: true,
      reportBoundExhausted: true,
      previousMetrics: metrics,
      latestMetrics: metrics,
      noChangeReason: 'Fresh rerun confirms no modeled trace movement',
      repeatedCandidateCycles: 0,
      noProgressCycles: 0,
      freshRerun: true,
      userStopped: false,
      realBlocker: null,
      adversarialVerdict: 'passed' as const,
      minimumOpportunity: 1,
    }
    expect(decideConvergence({...base, candidates: []})).toMatchObject({
      status: 'converged',
      reason: 'no-unaddressed-candidate-above-threshold',
    })
    expect(
      decideConvergence({
        ...base,
        candidates: [candidate({observedOpportunity: 0.5})],
      }),
    ).toMatchObject({
      status: 'converged',
      reason: 'insufficient-opportunity-confirmed-by-fresh-rerun',
    })
  })

  it('blocks repeated candidate/no-progress loops rather than claiming convergence', () => {
    expect(
      decideConvergence({
        evidenceValid: true,
        docsFresh: true,
        reportBoundExhausted: true,
        candidates: [candidate()],
        previousMetrics: metrics,
        latestMetrics: metrics,
        noChangeReason: 'Scoped behavior is outside the modeled trace',
        repeatedCandidateCycles: 2,
        noProgressCycles: 2,
        freshRerun: true,
        userStopped: false,
        realBlocker: null,
        adversarialVerdict: 'passed',
        minimumOpportunity: 1,
      }),
    ).toMatchObject({status: 'blocked', reason: 'repeated-candidate-no-progress-cycle'})
  })
})

describe('persona UX durable state and docs', () => {
  it('strictly decodes compatible checkpoints and rejects extras or versions', () => {
    const checkpoint = emptyCheckpoint('feature/persona-ux')
    expect(decodeCheckpoint(checkpoint)).toEqual(checkpoint)
    expect(() => decodeCheckpoint({...checkpoint, extra: true})).toThrow(/malformed/)
    expect(() => decodeCheckpoint({...checkpoint, schemaVersion: 2})).toThrow(/incompatible/)
  })

  it('increments durable loop counters only for repeated, non-improving cycles', () => {
    const checkpoint = {
      ...emptyCheckpoint('feature/persona-ux'),
      noProgressCycles: 1,
      repeatedCandidateCycles: 1,
      lastCandidateKey: 'credentialSetup',
      history: [
        {
          runId: 'run-1',
          sourceSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          candidateKey: 'credentialSetup',
          metrics,
          status: 'continue' as const,
          reason: 'ranked-candidates-remain',
        },
      ],
    }
    expect(nextLoopCounters(checkpoint, 'credentialSetup', metrics)).toEqual({
      repeatedCandidateCycles: 2,
      noProgressCycles: 2,
    })
    expect(
      nextLoopCounters(checkpoint, 'commandDiscoverability', {
        ...metrics,
        p95Friction: 39,
      }),
    ).toEqual({repeatedCandidateCycles: 0, noProgressCycles: 0})
  })

  it('keeps executable help explicit about commands, bounds, and exit behavior', () => {
    const help = renderHelp()
    expect(help).toContain('pnpm optimize:ux -- cycle')
    expect(help).toContain('default when omitted: 8')
    expect(help).toContain('--rubber-duck-verdict')
    expect(help).toContain('0 = valid cycle evidence')
    expect(help).toContain('1 = invalid evidence')
    expect(help).toContain('2 = malformed command-line usage')
  })

  it('defaults each run to eight iterations while allowing an explicit per-run value', () => {
    expect(resolveIterationCount(undefined)).toBe(8)
    expect(resolveIterationCount('5')).toBe(5)
    expect(() => resolveIterationCount('0')).toThrow(/1 through 20/)
    expect(() => resolveIterationCount('2.5')).toThrow(/integer/)
  })

  it('rejects unsupported command options before starting an optimizer run', () => {
    expect(() =>
      validateCommandArguments({
        command: 'cycle',
        values: new Map([['--unknown', ['value']]]),
        switches: new Set(),
      }),
    ).toThrow(/Unknown option --unknown/)
    expect(() =>
      validateCommandArguments({
        command: 'status',
        values: new Map(),
        switches: new Set(['--stop']),
      }),
    ).toThrow(/Unknown option --stop for status/)
  })

  it('keeps convergence pending or blocked until adversarial rubber-duck review resolves', () => {
    const input = {
      evidenceValid: true,
      docsFresh: true,
      reportBoundExhausted: false,
      candidates: [],
      previousMetrics: null,
      latestMetrics: metrics,
      noChangeReason: null,
      repeatedCandidateCycles: 0,
      noProgressCycles: 0,
      freshRerun: false,
      userStopped: false,
      realBlocker: null,
      minimumOpportunity: 1,
    }
    expect(decideConvergence({...input, adversarialVerdict: 'pending'})).toMatchObject({
      status: 'continue',
      reason: 'adversarial-rubber-duck-pending',
    })
    expect(decideConvergence({...input, adversarialVerdict: 'blocked'})).toMatchObject({
      status: 'blocked',
      reason: 'adversarial-rubber-duck-blocked',
    })
    expect(decideConvergence({...input, adversarialVerdict: 'revised'})).toMatchObject({
      status: 'continue',
      reason: 'adversarial-rubber-duck-revised',
    })
  })

  it('does not treat experiment-model or test diffs as implemented production behavior', () => {
    const diff = [
      'diff --git a/src/experience/persona-experiment.ts b/src/experience/persona-experiment.ts',
      '--- a/src/experience/persona-experiment.ts',
      '+++ b/src/experience/persona-experiment.ts',
      '+credentialSetup',
      'diff --git a/test/unit/example.test.ts b/test/unit/example.test.ts',
      '--- a/test/unit/example.test.ts',
      '+++ b/test/unit/example.test.ts',
      '+automationClarity',
      'diff --git a/src/commands/auth.ts b/src/commands/auth.ts',
      '--- a/src/commands/auth.ts',
      '+++ b/src/commands/auth.ts',
      '+credential readiness preflight',
    ].join('\n')
    expect(productionDiffText(diff)).toContain('src/commands/auth.ts')
    expect(productionDiffText(diff)).not.toContain('persona-experiment.ts')
    expect(productionDiffText(diff)).not.toContain('example.test.ts')
  })

  it('keeps commit prose out of represented evidence by accepting only diff file sections', () => {
    expect(
      productionDiffText(
        [
          'commit message mentioning credentialSetup',
          'diff --git a/README.md b/README.md',
          '--- a/README.md',
          '+++ b/README.md',
          '+automationClarity',
        ].join('\n'),
      ),
    ).toBe('')
  })

  it('asserts repository docs, script wiring, coverage counts, and safety guidance stay fresh', () => {
    const packageJson = readFileSync('package.json', 'utf8')
    const readme = readFileSync('README.md', 'utf8')
    const testing = readFileSync('docs/testing.md', 'utf8')
    const skill = readFileSync('skills/optimize-ux/SKILL.md', 'utf8')
    const references = [
      'workflow.md',
      'evidence-and-convergence.md',
      'rubber-duck.md',
      'safety-and-delivery.md',
    ]
      .map((file) => readFileSync(`skills/optimize-ux/references/${file}`, 'utf8'))
      .join('\n')
    expect(
      validateDocumentationContent({
        repositoryDocs: `${readme}\n${testing}`,
        skill,
        references,
        packageJson,
        commandCount: 3,
        flagCount: 27,
        entrypointCount: 6,
        conflictCount: 12,
      }),
    ).toEqual({fresh: true, failures: []})
    expect(
      validateDocumentationContent({
        repositoryDocs: `${readme}\n${testing.replace('27/27 flags', '26/26 flags')}`,
        skill,
        references,
        packageJson,
        commandCount: 3,
        flagCount: 27,
        entrypointCount: 6,
        conflictCount: 12,
      }).fresh,
    ).toBe(false)
  })
})
