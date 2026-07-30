import {Either, Schema} from 'effect'
import {
  DESIGN_ALTERNATIVES,
  EXPERIMENT_BASELINES,
  initialDesign,
  optimizeDesign,
  PERSONAS,
  rankLevers,
  RESEARCH_SOURCES,
  renderExperimentReport,
  renderTraceJsonl,
  validateTraceJsonl,
  evaluateIteration,
  type ExperimentConfig,
  type IterationMetrics,
  type LeverName,
  type PersonaExperimentResult,
  type ScenarioObservation,
} from '../../../src/experience/persona-experiment.js'
import {
  buildCliCoverageReport,
  CLI_JOURNEYS,
  cliJourneyObservations,
} from '../../../src/experience/cli-journeys.js'

export const CHECKPOINT_SCHEMA_VERSION = 1
export const MAX_SELECTED_FIXES = 10
export const FIX_BUDGET = 6
export const MAX_REPEATED_CANDIDATE_CYCLES = 2
export const MAX_NO_PROGRESS_CYCLES = 2

export const COMPLEXITY_POINTS = {
  small: 1,
  medium: 3,
  large: 5,
} as const

export type Complexity = keyof typeof COMPLEXITY_POINTS

export interface MetricSnapshot {
  readonly meanFriction: number
  readonly p95Friction: number
  readonly unintuitiveActions: number
  readonly highHarmActions: number
}

export interface CandidateEvidence {
  readonly lever: LeverName
  readonly alternativeId: string
  readonly highHarmActions: number
  readonly p95Friction: number
  readonly unintuitiveActions: number
  readonly meanFriction: number
  readonly traceCount: number
  readonly observedOpportunity: number
  readonly aboveThreshold: boolean
  readonly representedBy: ReadonlyArray<string>
}

export interface PlannedCandidate extends CandidateEvidence {
  readonly complexity: Complexity
  readonly points: number
}

export interface CandidatePlan {
  readonly selected: ReadonlyArray<PlannedCandidate>
  readonly deferred: ReadonlyArray<PlannedCandidate>
  readonly pointsUsed: number
}

export interface ArtifactValidationSummary {
  readonly valid: boolean
  readonly configuredIterations: number
  readonly cucumberIterationCount: number
  readonly cucumberRecordCount: number
  readonly traceLineCount: number
  readonly validTraceLineCount: number
  readonly malformedTraceLineCount: number
  readonly missingRecordCount: number
  readonly unexpectedRecordCount: number
  readonly failures: ReadonlyArray<string>
}

export interface EvidenceValidationInput {
  readonly report: unknown
  readonly traceJsonl: string
  readonly coverage: unknown
  readonly markdown: string
  readonly config: ExperimentConfig
  readonly cucumberIterations: ReadonlyArray<ReadonlyArray<ScenarioObservation>>
  readonly cucumberRecordCount: number
  readonly cucumberFailures?: ReadonlyArray<string>
}

export interface EvidenceValidationResult {
  readonly summary: ArtifactValidationSummary
  readonly expectedReport: PersonaExperimentResult
}

export interface ImprovementDecision {
  readonly blocking: boolean
  readonly improved: boolean
  readonly reason: string
}

export interface ConvergenceInput {
  readonly evidenceValid: boolean
  readonly docsFresh: boolean
  readonly reportBoundExhausted: boolean
  readonly candidates: ReadonlyArray<CandidateEvidence>
  readonly previousMetrics: MetricSnapshot | null
  readonly latestMetrics: MetricSnapshot
  readonly noChangeReason: string | null
  readonly repeatedCandidateCycles: number
  readonly noProgressCycles: number
  readonly freshRerun: boolean
  readonly userStopped: boolean
  readonly realBlocker: string | null
  readonly minimumOpportunity: number
}

export interface ConvergenceDecision {
  readonly status: 'continue' | 'converged' | 'blocked' | 'stopped'
  readonly reason: string
  readonly boundExhausted: boolean
  readonly improvement: ImprovementDecision
}

export interface LoopCounters {
  readonly repeatedCandidateCycles: number
  readonly noProgressCycles: number
}

const MetricSnapshotSchema = Schema.Struct({
  meanFriction: Schema.Number,
  p95Friction: Schema.Number,
  unintuitiveActions: Schema.Number,
  highHarmActions: Schema.Number,
})

const CycleHistorySchema = Schema.Struct({
  runId: Schema.String,
  sourceSha: Schema.String,
  baseSha: Schema.String,
  candidateKey: Schema.String,
  metrics: MetricSnapshotSchema,
  status: Schema.Literal('continue', 'converged', 'blocked', 'stopped'),
  reason: Schema.String,
})

const OptimizerCheckpointSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CHECKPOINT_SCHEMA_VERSION),
  branch: Schema.String,
  baseBranch: Schema.String,
  addressed: Schema.Array(Schema.String),
  noProgressCycles: Schema.Number,
  repeatedCandidateCycles: Schema.Number,
  lastCandidateKey: Schema.NullOr(Schema.String),
  history: Schema.Array(CycleHistorySchema),
  nextWakeup: Schema.NullOr(Schema.String),
})

export type OptimizerCheckpoint = Schema.Schema.Type<typeof OptimizerCheckpointSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    )
  }
  return value
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function collectDifferences(
  actual: unknown,
  expected: unknown,
  path: string,
  failures: string[],
  limit = 100,
): void {
  if (failures.length >= limit) {
    return
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      failures.push(`${path} must be an array`)
      return
    }
    if (actual.length !== expected.length) {
      failures.push(`${path} expected ${expected.length} records but found ${actual.length}`)
    }
    for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
      collectDifferences(actual[index], expected[index], `${path}[${index}]`, failures, limit)
    }
    return
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      failures.push(`${path} must be an object`)
      return
    }
    const expectedKeys = Object.keys(expected).sort()
    const actualKeys = Object.keys(actual).sort()
    for (const key of expectedKeys.filter((candidate) => !actualKeys.includes(candidate))) {
      failures.push(`${path} is missing key ${key}`)
    }
    for (const key of actualKeys.filter((candidate) => !expectedKeys.includes(candidate))) {
      failures.push(`${path} has unexpected key ${key}`)
    }
    for (const key of expectedKeys.filter((candidate) => actualKeys.includes(candidate))) {
      collectDifferences(actual[key], expected[key], `${path}.${key}`, failures, limit)
    }
    return
  }
  if (!Object.is(actual, expected)) {
    failures.push(`${path} does not match recomputed evidence`)
  }
}

function multiset(values: ReadonlyArray<unknown>): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) {
    const key = stableSerialize(value)
    result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result
}

function compareMultisets(
  actual: ReadonlyArray<unknown>,
  expected: ReadonlyArray<unknown>,
): {missing: number; unexpected: number} {
  const actualCounts = multiset(actual)
  const expectedCounts = multiset(expected)
  let missing = 0
  let unexpected = 0
  for (const [key, count] of expectedCounts) {
    missing += Math.max(0, count - (actualCounts.get(key) ?? 0))
  }
  for (const [key, count] of actualCounts) {
    unexpected += Math.max(0, count - (expectedCounts.get(key) ?? 0))
  }
  return {missing, unexpected}
}

function parseTraceLines(jsonl: string): {records: unknown[]; failures: string[]} {
  const records: unknown[] = []
  const failures: string[] = []
  const lines = jsonl.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.length === 0) {
      if (index !== lines.length - 1) {
        failures.push(`Trace line ${index + 1} is unexpectedly blank`)
      }
      return
    }
    try {
      records.push(JSON.parse(line) as unknown)
    } catch {
      failures.push(`Trace line ${index + 1} is not valid JSON`)
    }
  })
  return {records, failures}
}

export function buildExpectedReport(
  config: ExperimentConfig,
  cucumberIterations: ReadonlyArray<ReadonlyArray<ScenarioObservation>>,
): PersonaExperimentResult {
  const iterations = []
  const optimizationDecisions = []
  const optimizationNotes = []
  let design = initialDesign(config.baseline)

  for (let index = 0; index < config.iterations; index += 1) {
    const migrationScenarios = cucumberIterations[index]
    if (!migrationScenarios) {
      throw new Error(`Missing Cucumber observations for iteration ${index + 1}`)
    }
    const iteration = evaluateIteration(
      design,
      PERSONAS,
      [
        ...migrationScenarios.map((scenario) => ({
          ...scenario,
          source: scenario.source ?? ('migration-bdd' as const),
        })),
        ...cliJourneyObservations(),
      ],
      config.painThreshold,
    )
    iterations.push(iteration)
    if (index < config.iterations - 1) {
      const optimized = optimizeDesign(iteration, config.optimizationStep)
      if (optimized.decision) {
        optimizationDecisions.push(optimized.decision)
      }
      if (optimized.note) {
        optimizationNotes.push(optimized.note)
      }
      design = optimized.design
    }
  }

  const firstIteration = iterations[0]
  const lastIteration = iterations.at(-1)
  if (!firstIteration || !lastIteration) {
    throw new Error('Expected at least one experiment iteration')
  }
  const initialLeverRanking = rankLevers(firstIteration)
  const finalLeverRanking = rankLevers(lastIteration)
  return {
    baseline: EXPERIMENT_BASELINES[config.baseline],
    personas: PERSONAS,
    iterations,
    optimizationDecisions,
    optimizationNotes,
    finalDesign: design,
    alternatives: DESIGN_ALTERNATIVES,
    sources: RESEARCH_SOURCES,
    cliCoverage: buildCliCoverageReport(
      CLI_JOURNEYS,
      PERSONAS.map((persona) => persona.id),
    ),
    initialLeverRanking,
    finalLeverRanking,
    completion: {
      requestedIterations: config.iterations,
      completedIterations: iterations.length,
      converged: finalLeverRanking.length === 0,
      reason:
        finalLeverRanking.length === 0
          ? 'converged-no-candidate'
          : 'iteration-bound-reached-with-candidates',
      remainingCandidateCount: finalLeverRanking.length,
    },
  }
}

export function validateExperimentEvidence(
  input: EvidenceValidationInput,
): EvidenceValidationResult {
  const failures = [...(input.cucumberFailures ?? [])]
  let expectedReport: PersonaExperimentResult
  try {
    expectedReport = buildExpectedReport(input.config, input.cucumberIterations)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
    expectedReport = buildExpectedReport({...input.config, iterations: 1}, [
      input.cucumberIterations[0] ?? [],
    ])
  }

  collectDifferences(input.report, expectedReport, 'report', failures)
  collectDifferences(input.coverage, expectedReport.cliCoverage, 'cliCoverage', failures)
  if (input.markdown !== renderExperimentReport(expectedReport)) {
    failures.push('persona-experiment.md does not exactly match the recomputed report')
  }

  const traceValidation = validateTraceJsonl(input.traceJsonl)
  failures.push(...traceValidation.failures)
  const parsedTrace = parseTraceLines(input.traceJsonl)
  failures.push(...parsedTrace.failures)
  const expectedTrace = renderTraceJsonl(expectedReport)
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
  const linkage = compareMultisets(parsedTrace.records, expectedTrace)
  if (linkage.missing > 0) {
    failures.push(`Trace JSONL is missing ${linkage.missing} normalized report records`)
  }
  if (linkage.unexpected > 0) {
    failures.push(`Trace JSONL has ${linkage.unexpected} unexpected normalized records`)
  }

  return {
    expectedReport,
    summary: {
      valid: failures.length === 0,
      configuredIterations: input.config.iterations,
      cucumberIterationCount: input.cucumberIterations.length,
      cucumberRecordCount: input.cucumberRecordCount,
      traceLineCount: traceValidation.lineCount,
      validTraceLineCount: traceValidation.validLineCount,
      malformedTraceLineCount: traceValidation.malformedLineCount,
      missingRecordCount: linkage.missing,
      unexpectedRecordCount: linkage.unexpected,
      failures,
    },
  }
}

function quantile(values: ReadonlyArray<number>, fraction: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

export function metricSnapshot(metrics: IterationMetrics): MetricSnapshot {
  return {
    meanFriction: metrics.meanFriction,
    p95Friction: metrics.p95Friction,
    unintuitiveActions: metrics.unintuitiveActions,
    highHarmActions: metrics.highHarmActions,
  }
}

export function rankUnaddressedCandidates(
  report: PersonaExperimentResult,
  addressed: ReadonlySet<string>,
  representedBy: ReadonlyMap<string, ReadonlyArray<string>>,
  painThreshold: number,
): ReadonlyArray<CandidateEvidence> {
  const production = report.iterations[0]
  if (!production) {
    return []
  }
  return DESIGN_ALTERNATIVES.filter(
    (alternative) =>
      production.design.levers[alternative.lever] < 1 &&
      !addressed.has(alternative.lever) &&
      !addressed.has(alternative.id),
  )
    .map((alternative) => {
      const traces = production.traces.filter((trace) => trace.lever === alternative.lever)
      const scores = traces.map((trace) => trace.frictionScore)
      const highHarmActions = traces.filter((trace) => trace.frictionScore >= 60).length
      const unintuitiveActions = traces.filter((trace) => trace.unintuitive).length
      const p95Friction = rounded(quantile(scores, 0.95))
      const meanFriction = rounded(
        scores.reduce((total, score) => total + score, 0) / Math.max(1, scores.length),
      )
      const remainingGap = 1 - production.design.levers[alternative.lever]
      const observedOpportunity = rounded(
        (highHarmActions * 1000 + unintuitiveActions * 10 + meanFriction + p95Friction) *
          remainingGap,
      )
      return {
        lever: alternative.lever,
        alternativeId: alternative.id,
        highHarmActions,
        p95Friction,
        unintuitiveActions,
        meanFriction,
        traceCount: traces.length,
        observedOpportunity,
        aboveThreshold:
          highHarmActions > 0 || p95Friction >= painThreshold || unintuitiveActions > 0,
        representedBy: representedBy.get(alternative.lever) ?? [],
      }
    })
    .sort(
      (left, right) =>
        right.highHarmActions - left.highHarmActions ||
        right.p95Friction - left.p95Friction ||
        right.unintuitiveActions - left.unintuitiveActions ||
        left.lever.localeCompare(right.lever),
    )
}

export function selectCandidates(
  candidates: ReadonlyArray<CandidateEvidence>,
  complexities: Readonly<Record<string, Complexity>>,
  budget = FIX_BUDGET,
): CandidatePlan {
  const selected: PlannedCandidate[] = []
  const deferred: PlannedCandidate[] = []
  let pointsUsed = 0
  for (const candidate of candidates) {
    const complexity = complexities[candidate.lever] ?? 'medium'
    const planned = {...candidate, complexity, points: COMPLEXITY_POINTS[complexity]}
    if (
      selected.length < MAX_SELECTED_FIXES &&
      pointsUsed + planned.points <= budget &&
      candidate.aboveThreshold
    ) {
      selected.push(planned)
      pointsUsed += planned.points
    } else {
      deferred.push(planned)
    }
  }
  return {selected, deferred, pointsUsed}
}

export function compareMetrics(
  previous: MetricSnapshot | null,
  latest: MetricSnapshot,
  noChangeReason: string | null,
): ImprovementDecision {
  if (!previous) {
    return {blocking: false, improved: false, reason: 'initial-production-evidence-captured'}
  }
  if (latest.highHarmActions > previous.highHarmActions) {
    return {
      blocking: true,
      improved: false,
      reason: 'high-harm-actions-regressed',
    }
  }
  const improved =
    latest.highHarmActions < previous.highHarmActions ||
    latest.p95Friction < previous.p95Friction ||
    latest.unintuitiveActions < previous.unintuitiveActions ||
    latest.meanFriction < previous.meanFriction
  if (improved) {
    return {blocking: false, improved: true, reason: 'measurable-production-improvement'}
  }
  if (noChangeReason?.trim()) {
    return {
      blocking: false,
      improved: false,
      reason: `defensible-no-change: ${noChangeReason.trim()}`,
    }
  }
  return {blocking: true, improved: false, reason: 'no-measurable-improvement-without-explanation'}
}

export function nextLoopCounters(
  checkpoint: OptimizerCheckpoint,
  candidateKey: string,
  latestMetrics: MetricSnapshot,
): LoopCounters {
  const previous = checkpoint.history.at(-1)?.metrics
  const repeatedCandidateCycles =
    checkpoint.lastCandidateKey === candidateKey && candidateKey.length > 0
      ? checkpoint.repeatedCandidateCycles + 1
      : 0
  if (!previous) {
    return {repeatedCandidateCycles, noProgressCycles: 0}
  }
  const improved =
    latestMetrics.highHarmActions < previous.highHarmActions ||
    latestMetrics.p95Friction < previous.p95Friction ||
    latestMetrics.unintuitiveActions < previous.unintuitiveActions ||
    latestMetrics.meanFriction < previous.meanFriction
  const regressed = latestMetrics.highHarmActions > previous.highHarmActions
  return {
    repeatedCandidateCycles,
    noProgressCycles: !improved && !regressed ? checkpoint.noProgressCycles + 1 : 0,
  }
}

export function decideConvergence(input: ConvergenceInput): ConvergenceDecision {
  const improvement = compareMetrics(
    input.previousMetrics,
    input.latestMetrics,
    input.noChangeReason,
  )
  const base = {boundExhausted: input.reportBoundExhausted, improvement}
  if (input.userStopped) {
    return {...base, status: 'stopped', reason: 'user-stop-requested'}
  }
  if (!input.evidenceValid) {
    return {...base, status: 'blocked', reason: 'invalid-or-stale-evidence'}
  }
  if (!input.docsFresh) {
    return {...base, status: 'blocked', reason: 'documentation-freshness-gate-failed'}
  }
  if (input.realBlocker) {
    return {...base, status: 'blocked', reason: `real-blocker: ${input.realBlocker}`}
  }
  if (improvement.blocking) {
    return {...base, status: 'blocked', reason: improvement.reason}
  }
  if (
    input.repeatedCandidateCycles >= MAX_REPEATED_CANDIDATE_CYCLES ||
    input.noProgressCycles >= MAX_NO_PROGRESS_CYCLES
  ) {
    return {...base, status: 'blocked', reason: 'repeated-candidate-no-progress-cycle'}
  }

  const aboveThreshold = input.candidates.filter((candidate) => candidate.aboveThreshold)
  if (aboveThreshold.length === 0) {
    return {...base, status: 'converged', reason: 'no-unaddressed-candidate-above-threshold'}
  }
  const feasibleOpportunity = aboveThreshold.filter(
    (candidate) => candidate.observedOpportunity > input.minimumOpportunity,
  )
  if (
    feasibleOpportunity.length === 0 &&
    input.freshRerun &&
    input.previousMetrics !== null &&
    !improvement.improved &&
    !improvement.blocking
  ) {
    return {
      ...base,
      status: 'converged',
      reason: 'insufficient-opportunity-confirmed-by-fresh-rerun',
    }
  }
  return {
    ...base,
    status: 'continue',
    reason: input.reportBoundExhausted
      ? 'bound-exhausted-with-ranked-candidates'
      : 'ranked-candidates-remain',
  }
}

export function decodeCheckpoint(input: unknown): OptimizerCheckpoint {
  const decoded = Schema.decodeUnknownEither(OptimizerCheckpointSchema, {
    onExcessProperty: 'error',
  })(input)
  if (Either.isLeft(decoded)) {
    throw new Error('Optimizer checkpoint is malformed or has an incompatible schema version')
  }
  return decoded.right
}

export function emptyCheckpoint(branch: string, baseBranch = 'main'): OptimizerCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    branch,
    baseBranch,
    addressed: [],
    noProgressCycles: 0,
    repeatedCandidateCycles: 0,
    lastCandidateKey: null,
    history: [],
    nextWakeup: null,
  }
}
