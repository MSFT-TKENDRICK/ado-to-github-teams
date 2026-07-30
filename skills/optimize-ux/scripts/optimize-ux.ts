#!/usr/bin/env -S pnpm exec tsx

import {createHash, randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {access, mkdir, readFile, readdir, rename, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseEnvelope, TestStepResultStatus, type Duration} from '@cucumber/messages'
import {Query} from '@cucumber/query'
import {Context, Data, Effect, Layer} from 'effect'
import {
  DEFAULT_PERSONA_ITERATIONS,
  DESIGN_ALTERNATIVES,
  type ExperimentConfig,
  type ScenarioObservation,
} from '../../../src/experience/persona-experiment.js'
import {
  decodeCheckpoint,
  decideConvergence,
  emptyCheckpoint,
  metricSnapshot,
  nextLoopCounters,
  rankUnaddressedCandidates,
  selectCandidates,
  stableSerialize,
  validateExperimentEvidence,
  type Complexity,
  type MetricSnapshot,
  type OptimizerCheckpoint,
} from './core.js'

const DEFAULT_STATE_DIRECTORY = '.optimize-ux'
const DEFAULT_EVIDENCE_ROOT = path.join('reports', 'persona-experiments')
const PROCESS_TIMEOUT_MS = 120_000
const MAX_PROCESS_OUTPUT_BYTES = 5 * 1024 * 1024
const ALLOWED_CUCUMBER_ENVELOPES = new Set([
  'gherkinDocument',
  'meta',
  'pickle',
  'source',
  'stepDefinition',
  'testCase',
  'testCaseFinished',
  'testCaseStarted',
  'testRunFinished',
  'testRunStarted',
  'testStepFinished',
  'testStepStarted',
])

class OptimizerIoFailure extends Data.TaggedError('OptimizerIoFailure')<{
  readonly message: string
}> {}

class OptimizerProcessFailure extends Data.TaggedError('OptimizerProcessFailure')<{
  readonly message: string
  readonly command: string
}> {}

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
}

interface ProcessOptions {
  readonly cwd: string
  readonly inherit?: boolean
  readonly allowFailure?: boolean
  readonly timeoutMs?: number
}

interface FileSystemService {
  readonly access: (filePath: string) => Effect.Effect<boolean, OptimizerIoFailure>
  readonly mkdir: (directory: string) => Effect.Effect<void, OptimizerIoFailure>
  readonly readText: (filePath: string) => Effect.Effect<string, OptimizerIoFailure>
  readonly list: (directory: string) => Effect.Effect<ReadonlyArray<string>, OptimizerIoFailure>
  readonly stat: (
    filePath: string,
  ) => Effect.Effect<{readonly modifiedMs: number}, OptimizerIoFailure>
  readonly writeAtomic: (
    filePath: string,
    content: string,
  ) => Effect.Effect<void, OptimizerIoFailure>
}

class FileSystemTag extends Context.Tag('optimize-ux/FileSystem')<
  FileSystemTag,
  FileSystemService
>() {}

interface ProcessService {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessOptions,
  ) => Effect.Effect<ProcessResult, OptimizerProcessFailure>
}

class ProcessTag extends Context.Tag('optimize-ux/Process')<ProcessTag, ProcessService>() {}

function commandForHost(command: string): string {
  if (process.platform !== 'win32') {
    return command
  }
  return ['git', 'gh'].includes(command) ? `${command}.exe` : command
}

function commandInvocation(
  command: string,
  args: ReadonlyArray<string>,
): {readonly executable: string; readonly args: ReadonlyArray<string>} {
  if (process.platform === 'win32' && command === 'pnpm') {
    const pnpmEntry = process.env.npm_execpath
    if (!pnpmEntry) {
      throw new Error('Cannot locate the active pnpm entrypoint')
    }
    return {executable: process.execPath, args: [pnpmEntry, ...args]}
  }
  return {executable: commandForHost(command), args}
}

const FileSystemLive = Layer.succeed(FileSystemTag, {
  access: (filePath) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await access(filePath)
          return true
        } catch {
          return false
        }
      },
      catch: (error) =>
        new OptimizerIoFailure({
          message: `Cannot inspect ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }),
  mkdir: (directory) =>
    Effect.tryPromise({
      try: () => mkdir(directory, {recursive: true}).then(() => undefined),
      catch: (error) =>
        new OptimizerIoFailure({
          message: `Cannot create ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }),
  readText: (filePath) =>
    Effect.tryPromise({
      try: () => readFile(filePath, 'utf8'),
      catch: (error) =>
        new OptimizerIoFailure({
          message: `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }),
  list: (directory) =>
    Effect.tryPromise({
      try: () => readdir(directory),
      catch: (error) =>
        new OptimizerIoFailure({
          message: `Cannot list ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }),
  stat: (filePath) =>
    Effect.tryPromise({
      try: async () => ({modifiedMs: (await stat(filePath)).mtimeMs}),
      catch: (error) =>
        new OptimizerIoFailure({
          message: `Cannot stat ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }),
  writeAtomic: (filePath, content) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path.dirname(filePath), {recursive: true})
        const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(temporary, content, {encoding: 'utf8', flag: 'wx'})
        await rename(temporary, filePath)
      },
      catch: (error) =>
        new OptimizerIoFailure({
          message: `Cannot atomically write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    }),
})

const ProcessLive = Layer.succeed(ProcessTag, {
  run: (command, args, options) =>
    Effect.async<ProcessResult, OptimizerProcessFailure>((resume) => {
      let invocation: ReturnType<typeof commandInvocation>
      try {
        invocation = commandInvocation(command, args)
      } catch (error) {
        resume(
          Effect.fail(
            new OptimizerProcessFailure({
              command,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        )
        return
      }
      const child = spawn(invocation.executable, [...invocation.args], {
        cwd: options.cwd,
        env: process.env,
        stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) {
          child.kill()
          settled = true
          resume(
            Effect.fail(
              new OptimizerProcessFailure({
                command,
                message: `${command} exceeded the bounded ${options.timeoutMs ?? PROCESS_TIMEOUT_MS} ms timeout`,
              }),
            ),
          )
        }
      }, options.timeoutMs ?? PROCESS_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes <= MAX_PROCESS_OUTPUT_BYTES) {
          stdout += chunk.toString('utf8')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes <= MAX_PROCESS_OUTPUT_BYTES) {
          stderr += chunk.toString('utf8')
        }
      })
      child.once('error', (error) => {
        if (!settled) {
          clearTimeout(timeout)
          settled = true
          resume(
            Effect.fail(
              new OptimizerProcessFailure({
                command,
                message: error.message,
              }),
            ),
          )
        }
      })
      child.once('exit', (code) => {
        if (settled) {
          return
        }
        clearTimeout(timeout)
        settled = true
        if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
          resume(
            Effect.fail(
              new OptimizerProcessFailure({
                command,
                message: `${command} exceeded the bounded output limit`,
              }),
            ),
          )
          return
        }
        if (code !== 0 && !options.allowFailure) {
          resume(
            Effect.fail(
              new OptimizerProcessFailure({
                command,
                message: stderr.trim() || stdout.trim() || `exit code ${code ?? 1}`,
              }),
            ),
          )
          return
        }
        resume(Effect.succeed({stdout, stderr}))
      })
      return Effect.sync(() => {
        if (!settled) {
          child.kill()
        }
      })
    }),
})

export function renderHelp(): string {
  return `optimize-ux

Usage:
  pnpm optimize:ux -- cycle [options]
  pnpm optimize:ux -- validate --output-dir <directory> [options]
  pnpm optimize:ux -- status [--state-dir <directory>]

Cycle options:
  --iterations <1-20>             Per-run persona iterations (default when omitted: ${DEFAULT_PERSONA_ITERATIONS})
  --pain-threshold <0-100>        Modeled usability threshold (default: 40)
  --optimization-step <0-1>       Modeled lever step (default: 0.2)
  --complexity <lever=size>       Repeat for small, medium, or large
  --addressed <lever-or-id>       Repeat for a semantically represented change
  --rubber-duck-verdict <value>   pending, passed, revised, or blocked (default: pending)
  --rubber-duck-finding <text>    Repeat for each adversarial finding and resolution
  --validation <command=result>   Repeat to record focused validation
  --no-change-reason <text>       Required when a post-change rerun has no measurable movement
  --minimum-opportunity <number>  Insufficient-opportunity cutoff (default: 1)
  --next-wakeup <RFC3339>         Durable hourly/session resume target
  --real-blocker <text>           Record a genuine blocker without success-shaped output
  --stop                          Record an explicit user stop

Exit behavior:
  0 = valid cycle evidence and continue/converged/stopped decision
  1 = invalid evidence, stale source, docs gate failure, regression, no-progress loop, or blocker
  2 = malformed command-line usage

Generated evidence, checkpoints, traces, and receipts stay in ignored reports/ and
.optimize-ux/ paths. The command never edits production source or performs provider writes.`
}

interface ParsedArguments {
  readonly command: 'cycle' | 'validate' | 'status' | 'help'
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>
  readonly switches: ReadonlySet<string>
}

function parseArguments(argv: ReadonlyArray<string>): ParsedArguments {
  const first = argv[0]
  const command =
    first === undefined || first === '--help' || first === '-h'
      ? 'help'
      : first === 'cycle' || first === 'validate' || first === 'status'
        ? first
        : null
  if (!command) {
    throw new Error(`Unknown command ${first}`)
  }
  const values = new Map<string, string[]>()
  const switches = new Set<string>()
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flag?.startsWith('--')) {
      throw new Error(`Unexpected argument ${flag ?? ''}`)
    }
    if (flag === '--stop') {
      switches.add(flag)
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`)
    }
    values.set(flag, [...(values.get(flag) ?? []), value])
    index += 1
  }
  return {command, values, switches}
}

function singleValue(args: ParsedArguments, flag: string, fallback?: string): string | undefined {
  const values = args.values.get(flag)
  if (!values || values.length === 0) {
    return fallback
  }
  if (values.length > 1) {
    throw new Error(`${flag} may be specified only once`)
  }
  return values[0]
}

function numberValue(args: ParsedArguments, flag: string, fallback: number): number {
  const raw = singleValue(args, flag)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} must be a finite number`)
  }
  return value
}

export function resolveIterationCount(raw: string | undefined): number {
  const iterations = raw === undefined ? DEFAULT_PERSONA_ITERATIONS : Number(raw)
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
    throw new Error('--iterations must be an integer from 1 through 20')
  }
  return iterations
}

function experimentConfig(args: ParsedArguments): ExperimentConfig {
  const config = {
    baseline: 'production' as const,
    iterations: resolveIterationCount(singleValue(args, '--iterations')),
    optimizationStep: numberValue(args, '--optimization-step', 0.2),
    painThreshold: numberValue(args, '--pain-threshold', 40),
  }
  if (
    config.optimizationStep <= 0 ||
    config.optimizationStep > 1 ||
    config.painThreshold < 0 ||
    config.painThreshold > 100
  ) {
    throw new Error('Experiment options are outside their documented bounds')
  }
  return config
}

interface AdversarialReview {
  readonly mode: 'rubber-duck-adversarial'
  readonly verdict: 'pending' | 'passed' | 'revised' | 'blocked'
  readonly findings: ReadonlyArray<string>
}

function adversarialReview(args: ParsedArguments): AdversarialReview {
  const verdict = singleValue(args, '--rubber-duck-verdict', 'pending')
  if (!verdict || !['pending', 'passed', 'revised', 'blocked'].includes(verdict)) {
    throw new Error('--rubber-duck-verdict must be pending, passed, revised, or blocked')
  }
  const findings = args.values.get('--rubber-duck-finding') ?? []
  if (verdict !== 'pending' && findings.length === 0) {
    throw new Error('A completed rubber-duck verdict requires at least one recorded finding')
  }
  return {
    mode: 'rubber-duck-adversarial',
    verdict: verdict as AdversarialReview['verdict'],
    findings,
  }
}

function validateCommandArguments(args: ParsedArguments): void {
  if (args.command === 'cycle' || args.command === 'validate') {
    experimentConfig(args)
  }
  if (args.command === 'cycle') {
    parseComplexities(args)
    adversarialReview(args)
    numberValue(args, '--minimum-opportunity', 1)
  }
}

function parseComplexities(args: ParsedArguments): Record<string, Complexity> {
  return Object.fromEntries(
    (args.values.get('--complexity') ?? []).map((entry) => {
      const [lever, complexity, extra] = entry.split('=')
      if (
        !lever ||
        !complexity ||
        extra !== undefined ||
        !['small', 'medium', 'large'].includes(complexity)
      ) {
        throw new Error(`Invalid complexity ${entry}; expected lever=small|medium|large`)
      }
      return [lever, complexity as Complexity]
    }),
  )
}

function durationMilliseconds(duration: Duration | undefined): number {
  return duration ? duration.seconds * 1000 + duration.nanos / 1_000_000 : 0
}

interface CucumberLoadResult {
  readonly observations: ReadonlyArray<ScenarioObservation>
  readonly recordCount: number
  readonly envelopeCounts: Readonly<Record<string, number>>
  readonly failures: ReadonlyArray<string>
}

export function parseCucumberJsonl(raw: string, iteration: number): CucumberLoadResult {
  const query = new Query()
  const failures: string[] = []
  const envelopeCounts: Record<string, number> = {}
  const lines = raw.split(/\r?\n/)
  let recordCount = 0
  lines.forEach((line, index) => {
    if (line.length === 0) {
      if (index !== lines.length - 1) {
        failures.push(`Cucumber iteration ${iteration} line ${index + 1} is unexpectedly blank`)
      }
      return
    }
    recordCount += 1
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1
      ) {
        failures.push(
          `Cucumber iteration ${iteration} line ${index + 1} must contain exactly one envelope`,
        )
        return
      }
      const envelopeType = Object.keys(parsed)[0]
      if (!envelopeType || !ALLOWED_CUCUMBER_ENVELOPES.has(envelopeType)) {
        failures.push(
          `Cucumber iteration ${iteration} line ${index + 1} has unexpected envelope ${envelopeType ?? 'unknown'}`,
        )
        return
      }
      envelopeCounts[envelopeType] = (envelopeCounts[envelopeType] ?? 0) + 1
      query.update(parseEnvelope(line))
    } catch {
      failures.push(`Cucumber iteration ${iteration} line ${index + 1} is malformed`)
    }
  })
  const observations = query.findAllTestCaseStarted().map((testCaseStarted) => {
    const pickle = query.findPickleBy(testCaseStarted)
    const lineage = pickle ? query.findLineageBy(pickle) : undefined
    const result = query.findMostSevereTestStepResultBy(testCaseStarted)
    return {
      feature: lineage?.feature?.name ?? 'Unnamed feature',
      scenario: pickle?.name ?? 'Unnamed scenario',
      status: (result?.status ?? TestStepResultStatus.UNKNOWN).toLowerCase(),
      durationMs: durationMilliseconds(query.findTestCaseDurationBy(testCaseStarted)),
      steps: pickle?.steps.map((step) => step.text) ?? [],
    }
  })
  if (observations.length === 0) {
    failures.push(`Cucumber iteration ${iteration} has no scenario observations`)
  }
  if (observations.some((observation) => observation.status !== 'passed')) {
    failures.push(`Cucumber iteration ${iteration} contains a non-passing or incomplete scenario`)
  }
  return {
    observations: observations.sort(
      (left, right) =>
        left.feature.localeCompare(right.feature) || left.scenario.localeCompare(right.scenario),
    ),
    recordCount,
    envelopeCounts,
    failures,
  }
}

interface RepositoryPr {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly headRefName: string
  readonly baseRefName: string
  readonly url: string
}

interface RepositoryState {
  readonly root: string
  readonly branch: string
  readonly sourceSha: string
  readonly baseSha: string
  readonly gitDirectory: string
  readonly worktreeFingerprint: string
  readonly changedFiles: ReadonlyArray<string>
  readonly currentPr: RepositoryPr | null
  readonly openPrs: ReadonlyArray<RepositoryPr>
  readonly mergedPrs: ReadonlyArray<RepositoryPr>
  readonly inspectedDiffs: ReadonlyArray<string>
  readonly representedText: string
}

function parseJsonArray<T>(value: string, label: string): T[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} did not return an array`)
  }
  return parsed as T[]
}

function discoverRepository(includePrs: boolean) {
  return Effect.gen(function* () {
    const processService = yield* ProcessTag
    const cwd = process.cwd()
    const git = (args: ReadonlyArray<string>, allowFailure = false) =>
      processService.run('git', args, {cwd, allowFailure})
    const root = (yield* git(['rev-parse', '--show-toplevel'])).stdout.trim()
    const [branch, sourceSha, baseSha, gitDirectory, statusResult, diffResult] = yield* Effect.all(
      [
        git(['branch', '--show-current']),
        git(['rev-parse', 'HEAD']),
        git(['rev-parse', 'origin/main']),
        git(['rev-parse', '--git-dir']),
        git(['status', '--porcelain=v1', '--untracked-files=all']),
        git(['--no-pager', 'diff', '--binary', 'HEAD']),
      ],
      {concurrency: 3},
    )
    const branchName = branch.stdout.trim()
    const changedFiles = statusResult.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
    const worktreeFingerprint = createHash('sha256')
      .update(statusResult.stdout)
      .update('\0')
      .update(diffResult.stdout)
      .digest('hex')
    if (!includePrs) {
      return {
        root,
        branch: branchName,
        sourceSha: sourceSha.stdout.trim(),
        baseSha: baseSha.stdout.trim(),
        gitDirectory: gitDirectory.stdout.trim(),
        worktreeFingerprint,
        changedFiles,
        currentPr: null,
        openPrs: [],
        mergedPrs: [],
        inspectedDiffs: [],
        representedText: '',
      } satisfies RepositoryState
    }

    const gh = (args: ReadonlyArray<string>, allowFailure = false) =>
      processService.run('gh', args, {cwd: root, allowFailure})
    const fields = 'number,title,body,headRefName,baseRefName,url'
    const [openResult, mergedResult, currentResult, historyBaseResult] = yield* Effect.all(
      [
        gh(['pr', 'list', '--state', 'open', '--limit', '20', '--json', fields]),
        gh(['pr', 'list', '--state', 'merged', '--limit', '20', '--json', fields]),
        gh(['pr', 'view', '--json', fields], true),
        git(['rev-list', '--max-count=1', '--skip=20', 'origin/main']),
      ],
      {concurrency: 3},
    )
    const openPrs = parseJsonArray<RepositoryPr>(openResult.stdout, 'Open PR discovery')
    const mergedPrs = parseJsonArray<RepositoryPr>(mergedResult.stdout, 'Merged PR discovery')
    const currentPr =
      currentResult.stdout.trim().length > 0
        ? (JSON.parse(currentResult.stdout) as RepositoryPr)
        : null
    const historyBase = historyBaseResult.stdout.trim() || baseSha.stdout.trim()
    const mergedDiff = yield* git(['--no-pager', 'diff', '--patch', historyBase, 'origin/main'])
    const openDiffResults = yield* Effect.all(
      openPrs.map((pr) =>
        gh(['pr', 'diff', String(pr.number), '--patch', '--color=never']).pipe(
          Effect.map((result) => ({
            id: `open-pr-${pr.number}`,
            diff: productionDiffText(result.stdout),
            pr,
          })),
        ),
      ),
      {concurrency: 2},
    )
    return {
      root,
      branch: branchName,
      sourceSha: sourceSha.stdout.trim(),
      baseSha: baseSha.stdout.trim(),
      gitDirectory: gitDirectory.stdout.trim(),
      worktreeFingerprint,
      changedFiles,
      currentPr,
      openPrs,
      mergedPrs,
      inspectedDiffs: ['origin/main:last-20-commits', ...openDiffResults.map(({id}) => id)],
      representedText: [
        productionDiffText(mergedDiff.stdout),
        ...openDiffResults
          .filter(({diff}) => diff.length > 0)
          .flatMap(({diff, pr}) => [pr.title, pr.body, pr.headRefName, diff]),
      ].join('\n'),
    } satisfies RepositoryState
  })
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function productionDiffText(diff: string): string {
  return diff
    .split(/^diff --git /m)
    .slice(1)
    .filter((section) => {
      const pathMatch = section.match(/^a\/(\S+) b\/\S+/)
      const filePath = pathMatch?.[1]?.replaceAll('\\', '/') ?? ''
      return (
        filePath.startsWith('src/') &&
        !filePath.startsWith('src/experience/') &&
        !filePath.endsWith('.test.ts')
      )
    })
    .map((section) => `diff --git ${section}`)
    .join('\n')
}

function representedCandidates(text: string): {
  readonly addressed: ReadonlySet<string>
  readonly representedBy: ReadonlyMap<string, ReadonlyArray<string>>
} {
  const normalized = normalizeSearch(text)
  const addressed = new Set<string>()
  const representedBy = new Map<string, string[]>()
  for (const alternative of DESIGN_ALTERNATIVES) {
    const tokens = [alternative.lever, alternative.id, alternative.title]
    const matches = tokens.filter((token) => normalized.includes(normalizeSearch(token)))
    if (matches.length > 0) {
      addressed.add(alternative.lever)
      addressed.add(alternative.id)
      representedBy.set(alternative.lever, matches)
    }
  }
  return {addressed, representedBy}
}

interface LoadedEvidence {
  readonly report: unknown
  readonly traceJsonl: string
  readonly coverage: unknown
  readonly markdown: string
  readonly cucumberIterations: ReadonlyArray<ReadonlyArray<ScenarioObservation>>
  readonly cucumberRecordCount: number
  readonly cucumberFailures: ReadonlyArray<string>
}

function loadEvidence(outputDirectory: string, config: ExperimentConfig) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemTag
    const expectedFiles = new Set([
      'cli-coverage.json',
      'optimizer-run.json',
      'persona-actions.jsonl',
      'persona-experiment.json',
      'persona-experiment.md',
      ...Array.from({length: config.iterations}, (_, index) => `cucumber-${index + 1}.ndjson`),
    ])
    const actualFiles = yield* fileSystem.list(outputDirectory)
    const cucumberFailures: string[] = []
    for (const missing of [...expectedFiles].filter((file) => !actualFiles.includes(file))) {
      cucumberFailures.push(`Evidence directory is missing ${missing}`)
    }
    for (const unexpected of actualFiles.filter((file) => !expectedFiles.has(file))) {
      cucumberFailures.push(`Evidence directory has unexpected artifact ${unexpected}`)
    }
    const cucumberResults = yield* Effect.all(
      Array.from({length: config.iterations}, (_, index) =>
        fileSystem
          .readText(path.join(outputDirectory, `cucumber-${index + 1}.ndjson`))
          .pipe(Effect.map((raw) => parseCucumberJsonl(raw, index + 1))),
      ),
      {concurrency: 4},
    )
    cucumberFailures.push(...cucumberResults.flatMap((result) => result.failures))
    const firstCucumber = cucumberResults[0]
    if (firstCucumber) {
      const expectedEnvelopeCounts = stableSerialize(firstCucumber.envelopeCounts)
      const expectedScenarioShape = stableSerialize(
        firstCucumber.observations.map(({durationMs: _, ...observation}) => observation),
      )
      cucumberResults.slice(1).forEach((result, index) => {
        const iteration = index + 2
        if (stableSerialize(result.envelopeCounts) !== expectedEnvelopeCounts) {
          cucumberFailures.push(
            `Cucumber iteration ${iteration} has a missing or unexpected envelope record count`,
          )
        }
        const scenarioShape = stableSerialize(
          result.observations.map(({durationMs: _, ...observation}) => observation),
        )
        if (scenarioShape !== expectedScenarioShape) {
          cucumberFailures.push(
            `Cucumber iteration ${iteration} has a missing or unexpected scenario record`,
          )
        }
      })
    }
    const [report, traceJsonl, coverage, markdown] = yield* Effect.all(
      [
        fileSystem.readText(path.join(outputDirectory, 'persona-experiment.json')),
        fileSystem.readText(path.join(outputDirectory, 'persona-actions.jsonl')),
        fileSystem.readText(path.join(outputDirectory, 'cli-coverage.json')),
        fileSystem.readText(path.join(outputDirectory, 'persona-experiment.md')),
      ],
      {concurrency: 4},
    )
    return {
      report: JSON.parse(report) as unknown,
      traceJsonl,
      coverage: JSON.parse(coverage) as unknown,
      markdown,
      cucumberIterations: cucumberResults.map((result) => result.observations),
      cucumberRecordCount: cucumberResults.reduce((total, result) => total + result.recordCount, 0),
      cucumberFailures,
    } satisfies LoadedEvidence
  })
}

interface DocumentationGate {
  readonly fresh: boolean
  readonly failures: ReadonlyArray<string>
}

export function validateDocumentationContent(input: {
  readonly repositoryDocs: string
  readonly skill: string
  readonly references: string
  readonly packageJson: string
  readonly commandCount: number
  readonly flagCount: number
  readonly entrypointCount: number
  readonly conflictCount: number
}): DocumentationGate {
  const failures: string[] = []
  const packageData = JSON.parse(input.packageJson) as {scripts?: Record<string, string>}
  const expectedScript = 'tsx skills/optimize-ux/scripts/optimize-ux.ts'
  if (packageData.scripts?.['optimize:ux'] !== expectedScript) {
    failures.push('package.json optimize:ux script is missing or stale')
  }
  const requiredDocumentation = [
    'skills/optimize-ux',
    'pnpm optimize:ux -- cycle',
    `${input.commandCount}/${input.commandCount} commands`,
    `${input.flagCount}/${input.flagCount} flags`,
    `${input.entrypointCount}/${input.entrypointCount} entrypoints`,
    `${input.conflictCount}/${input.conflictCount} conflicts`,
    'optimizer-run.json',
    'cycle-receipt',
    'Exit behavior',
    'source SHA',
    'configurable per run',
  ]
  for (const token of requiredDocumentation.filter(
    (candidate) => !input.repositoryDocs.includes(candidate),
  )) {
    failures.push(`Repository docs are missing required freshness token: ${token}`)
  }
  const requiredSkill = [
    'references/workflow.md',
    'references/evidence-and-convergence.md',
    'references/rubber-duck.md',
    'references/safety-and-delivery.md',
    'pnpm optimize:ux -- cycle',
  ]
  for (const token of requiredSkill.filter((candidate) => !input.skill.includes(candidate))) {
    failures.push(`SKILL.md is missing activation token: ${token}`)
  }
  const requiredReferences = [
    'dry-run',
    'explicit approval',
    'iteration-bound-reached-with-candidates',
    'high-harm',
    'hourly',
    'gh stack merge',
    'cycle receipt',
    'generated reports',
    'adversarial rubber duck',
  ]
  for (const token of requiredReferences.filter(
    (candidate) => !input.references.includes(candidate),
  )) {
    failures.push(`Skill references are missing required policy token: ${token}`)
  }
  return {fresh: failures.length === 0, failures}
}

function documentationGate(root: string, report: ReturnType<typeof validateExperimentEvidence>) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemTag
    const referencePaths = [
      'workflow.md',
      'evidence-and-convergence.md',
      'rubber-duck.md',
      'safety-and-delivery.md',
    ].map((file) => path.join(root, 'skills', 'optimize-ux', 'references', file))
    const [readme, testing, skill, packageJson, ...references] = yield* Effect.all(
      [
        fileSystem.readText(path.join(root, 'README.md')),
        fileSystem.readText(path.join(root, 'docs', 'testing.md')),
        fileSystem.readText(path.join(root, 'skills', 'optimize-ux', 'SKILL.md')),
        fileSystem.readText(path.join(root, 'package.json')),
        ...referencePaths.map((reference) => fileSystem.readText(reference)),
      ],
      {concurrency: 4},
    )
    const coverage = report.expectedReport.cliCoverage
    return validateDocumentationContent({
      repositoryDocs: `${readme}\n${testing}`,
      skill,
      packageJson,
      references: references.join('\n'),
      commandCount: coverage.commandCount,
      flagCount: coverage.flagCount,
      entrypointCount: coverage.entrypointCount,
      conflictCount: coverage.conflictCount,
    })
  })
}

function loadCheckpoint(checkpointPath: string, branch: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemTag
    if (!(yield* fileSystem.access(checkpointPath))) {
      return emptyCheckpoint(branch)
    }
    return decodeCheckpoint(JSON.parse(yield* fileSystem.readText(checkpointPath)) as unknown)
  })
}

function assertAppOwnedWorktree(repository: RepositoryState): void {
  if (
    repository.branch === 'main' ||
    repository.branch.length === 0 ||
    !repository.gitDirectory.toLowerCase().includes('worktrees')
  ) {
    throw new Error(
      'Persona optimization requires a non-main app-owned Git worktree; production evidence is refused here',
    )
  }
}

function assertFreshSource(before: RepositoryState, after: RepositoryState): void {
  if (
    before.sourceSha !== after.sourceSha ||
    before.baseSha !== after.baseSha ||
    before.worktreeFingerprint !== after.worktreeFingerprint
  ) {
    throw new Error('Repository source changed during the experiment; stale evidence was refused')
  }
}

function runExperiment(root: string, outputDirectory: string, config: ExperimentConfig) {
  return Effect.gen(function* () {
    const processService = yield* ProcessTag
    yield* processService.run(
      'pnpm',
      [
        'experiment:personas',
        '--',
        '--baseline',
        config.baseline,
        '--iterations',
        String(config.iterations),
        '--optimization-step',
        String(config.optimizationStep),
        '--pain-threshold',
        String(config.painThreshold),
        '--output-dir',
        outputDirectory,
      ],
      {cwd: root, inherit: true, timeoutMs: 10 * 60_000},
    )
  })
}

function validateManifest(
  manifest: unknown,
  config: ExperimentConfig,
  repository: RepositoryState,
  runId: string,
): ReadonlyArray<string> {
  const expected = {
    schemaVersion: 1,
    runId,
    sourceSha: repository.sourceSha,
    baseSha: repository.baseSha,
    branch: repository.branch,
    worktreeFingerprint: repository.worktreeFingerprint,
    config,
  }
  return stableSerialize(manifest) === stableSerialize(expected)
    ? []
    : ['optimizer-run.json does not match the live source/config provenance']
}

function runCycle(args: ParsedArguments) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemTag
    const processService = yield* ProcessTag
    const config = experimentConfig(args)
    const stateDirectory = path.resolve(
      singleValue(args, '--state-dir', DEFAULT_STATE_DIRECTORY) ?? DEFAULT_STATE_DIRECTORY,
    )
    yield* processService.run('git', ['fetch', 'origin', 'main', '--quiet'], {
      cwd: process.cwd(),
      timeoutMs: 120_000,
    })
    const before = yield* discoverRepository(true)
    assertAppOwnedWorktree(before)
    const checkpointPath = path.join(stateDirectory, 'checkpoint.json')
    const checkpoint = yield* loadCheckpoint(checkpointPath, before.branch)
    if (checkpoint.branch !== before.branch || checkpoint.baseBranch !== 'main') {
      throw new Error('Checkpoint branch/base is incompatible with this app session')
    }

    const createdAt = new Date().toISOString()
    const runId = `${createdAt.replace(/[:.]/g, '-')}-${before.sourceSha.slice(0, 12)}`
    const outputDirectory = path.resolve(
      singleValue(args, '--output-dir', path.join(DEFAULT_EVIDENCE_ROOT, runId)) ??
        path.join(DEFAULT_EVIDENCE_ROOT, runId),
    )
    yield* fileSystem.mkdir(outputDirectory)
    yield* runExperiment(before.root, outputDirectory, config)
    const after = yield* discoverRepository(false)
    assertFreshSource(before, after)
    const manifest = {
      schemaVersion: 1,
      runId,
      sourceSha: before.sourceSha,
      baseSha: before.baseSha,
      branch: before.branch,
      worktreeFingerprint: before.worktreeFingerprint,
      config,
    }
    yield* fileSystem.writeAtomic(
      path.join(outputDirectory, 'optimizer-run.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    const loaded = yield* loadEvidence(outputDirectory, config)
    const validation = validateExperimentEvidence({
      ...loaded,
      config,
      cucumberFailures: [
        ...loaded.cucumberFailures,
        ...validateManifest(manifest, config, before, runId),
      ],
    })
    const docs = yield* documentationGate(before.root, validation)
    const represented = representedCandidates(before.representedText)
    const explicitAddressed = args.values.get('--addressed') ?? []
    const addressed = new Set([
      ...checkpoint.addressed,
      ...represented.addressed,
      ...explicitAddressed,
    ])
    const candidates = rankUnaddressedCandidates(
      validation.expectedReport,
      addressed,
      represented.representedBy,
      config.painThreshold,
    )
    const plan = selectCandidates(candidates, parseComplexities(args))
    const productionIteration = validation.expectedReport.iterations[0]
    const modeledFinalIteration = validation.expectedReport.iterations.at(-1)
    if (!productionIteration || !modeledFinalIteration) {
      throw new Error('Validated report did not contain initial and final metrics')
    }
    const latestMetrics = metricSnapshot(productionIteration.metrics)
    const previousHistory = checkpoint.history.at(-1)
    const previousMetrics: MetricSnapshot | null = previousHistory?.metrics ?? null
    const candidateKey = plan.selected
      .map((candidate) => candidate.lever)
      .sort()
      .join(',')
    const {repeatedCandidateCycles, noProgressCycles} = nextLoopCounters(
      checkpoint,
      candidateKey,
      latestMetrics,
    )
    const review = adversarialReview(args)
    const convergence = decideConvergence({
      evidenceValid: validation.summary.valid,
      docsFresh: docs.fresh,
      reportBoundExhausted:
        validation.expectedReport.completion.reason === 'iteration-bound-reached-with-candidates',
      candidates,
      previousMetrics,
      latestMetrics,
      noChangeReason: singleValue(args, '--no-change-reason') ?? null,
      repeatedCandidateCycles,
      noProgressCycles,
      freshRerun: previousHistory !== undefined,
      userStopped: args.switches.has('--stop'),
      realBlocker: singleValue(args, '--real-blocker') ?? null,
      adversarialVerdict: review.verdict,
      minimumOpportunity: numberValue(args, '--minimum-opportunity', 1),
    })
    const nextWakeup = singleValue(args, '--next-wakeup') ?? null
    const validations = args.values.get('--validation') ?? []
    const docsChanged = before.changedFiles.filter((file) => file.endsWith('.md'))
    const codeChanged = before.changedFiles.filter((file) => !docsChanged.includes(file))
    const receipt = {
      schemaVersion: 1,
      runIdentity: {runId, createdAt},
      source: {
        branch: before.branch,
        sourceSha: before.sourceSha,
        baseBranch: 'main',
        baseSha: before.baseSha,
        worktreeFingerprint: before.worktreeFingerprint,
      },
      baseline: {
        id: validation.expectedReport.baseline.id,
        source: validation.expectedReport.baseline.source,
      },
      artifactValidation: validation.summary,
      selected: plan.selected,
      deferred: plan.deferred,
      complexityBudget: {limit: 6, used: plan.pointsUsed},
      addressed: [...addressed].sort(),
      representedChanges: Object.fromEntries(represented.representedBy),
      codeChanged,
      docsChanged,
      documentationGate: docs,
      adversarialReview: review,
      validations: [
        'pnpm experiment:personas=passed',
        `exact-artifact-validation=${validation.summary.valid ? 'passed' : 'failed'}`,
        `documentation-freshness=${docs.fresh ? 'passed' : 'failed'}`,
        ...validations,
      ],
      metrics: {
        previousProduction: previousMetrics,
        initialProduction: latestMetrics,
        modeledFinal: metricSnapshot(modeledFinalIteration.metrics),
      },
      failures: [...validation.summary.failures, ...docs.failures],
      malformedTraces: validation.summary.malformedTraceLineCount,
      prState: {
        current: before.currentPr,
        open: before.openPrs,
        mergedInspected: before.mergedPrs.map(({number, title, url}) => ({number, title, url})),
        inspectedDiffs: before.inspectedDiffs,
        delivery: 'standalone',
        stack: null,
      },
      reportCompletion: validation.expectedReport.completion,
      remainingRankedFrictions: candidates,
      convergence,
      nextWakeup,
      resumeCheckpoint: checkpointPath,
      evidenceDirectory: outputDirectory,
    }
    const receiptsDirectory = path.join(stateDirectory, 'receipts')
    const receiptPath = path.join(receiptsDirectory, `${runId}.json`)
    yield* fileSystem.writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    yield* fileSystem.writeAtomic(
      path.join(stateDirectory, 'latest-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    )
    const nextCheckpoint: OptimizerCheckpoint = {
      ...checkpoint,
      addressed: [...addressed].sort(),
      noProgressCycles,
      repeatedCandidateCycles,
      lastCandidateKey: candidateKey || null,
      history: [
        ...checkpoint.history,
        {
          runId,
          sourceSha: before.sourceSha,
          baseSha: before.baseSha,
          candidateKey,
          metrics: latestMetrics,
          status: convergence.status,
          reason: convergence.reason,
        },
      ].slice(-20),
      nextWakeup,
    }
    yield* fileSystem.writeAtomic(checkpointPath, `${JSON.stringify(nextCheckpoint, null, 2)}\n`)
    console.log(
      JSON.stringify(
        {
          runId,
          receipt: receiptPath,
          evidence: outputDirectory,
          validation: validation.summary,
          selected: plan.selected.map(({lever, complexity, points}) => ({
            lever,
            complexity,
            points,
          })),
          convergence,
        },
        null,
        2,
      ),
    )
    if (!validation.summary.valid || !docs.fresh || convergence.status === 'blocked') {
      process.exitCode = 1
    }
  })
}

function validateExisting(args: ParsedArguments) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemTag
    const config = experimentConfig(args)
    const repository = yield* discoverRepository(false)
    assertAppOwnedWorktree(repository)
    const outputDirectory = path.resolve(
      singleValue(args, '--output-dir', DEFAULT_EVIDENCE_ROOT) ?? DEFAULT_EVIDENCE_ROOT,
    )
    const loaded = yield* loadEvidence(outputDirectory, config)
    const manifest = JSON.parse(
      yield* fileSystem.readText(path.join(outputDirectory, 'optimizer-run.json')),
    ) as unknown
    const manifestRecord =
      typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)
        ? (manifest as Record<string, unknown>)
        : {}
    const runId = typeof manifestRecord.runId === 'string' ? manifestRecord.runId : ''
    const validation = validateExperimentEvidence({
      ...loaded,
      config,
      cucumberFailures: [
        ...loaded.cucumberFailures,
        ...validateManifest(manifest, config, repository, runId),
      ],
    })
    console.log(JSON.stringify(validation.summary, null, 2))
    if (!validation.summary.valid) {
      process.exitCode = 1
    }
  })
}

function showStatus(args: ParsedArguments) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemTag
    const stateDirectory = path.resolve(
      singleValue(args, '--state-dir', DEFAULT_STATE_DIRECTORY) ?? DEFAULT_STATE_DIRECTORY,
    )
    const checkpointPath = path.join(stateDirectory, 'checkpoint.json')
    if (!(yield* fileSystem.access(checkpointPath))) {
      console.log('No durable persona UX optimizer checkpoint exists.')
      return
    }
    const checkpoint = decodeCheckpoint(
      JSON.parse(yield* fileSystem.readText(checkpointPath)) as unknown,
    )
    console.log(JSON.stringify(checkpoint, null, 2))
  })
}

async function main(): Promise<void> {
  let args: ParsedArguments
  try {
    args = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(renderHelp())
    process.exitCode = 2
    return
  }
  if (args.command === 'help') {
    console.log(renderHelp())
    return
  }
  try {
    validateCommandArguments(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(renderHelp())
    process.exitCode = 2
    return
  }
  const program =
    args.command === 'cycle'
      ? runCycle(args)
      : args.command === 'validate'
        ? validateExisting(args)
        : showStatus(args)
  await Effect.runPromise(
    program.pipe(Effect.provide(Layer.mergeAll(FileSystemLive, ProcessLive))),
  ).catch((error: unknown) => {
    const message =
      error instanceof OptimizerIoFailure || error instanceof OptimizerProcessFailure
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
    console.error(message)
    process.exitCode = 1
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
