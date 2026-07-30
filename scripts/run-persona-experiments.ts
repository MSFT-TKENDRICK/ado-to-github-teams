import {spawn} from 'node:child_process'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {parseEnvelope, TestStepResultStatus, type Duration} from '@cucumber/messages'
import {Query} from '@cucumber/query'
import {Cause, Effect, Exit, Layer} from 'effect'
import {
  decodeExperimentConfig,
  ExperimentArtifactFailure,
  ExperimentArtifactWriterTag,
  renderExperimentReport,
  renderTraceJsonl,
  runPersonaExperiment,
  ScenarioRunFailure,
  ScenarioRunnerTag,
  type PersonaExperimentResult,
  type ScenarioObservation,
} from '../src/experience/persona-experiment.js'

const root = process.cwd()
const defaultOutputDirectory = path.join(root, 'reports', 'persona-experiments')
const cucumberBin = path.join(root, 'node_modules', '@cucumber', 'cucumber', 'bin', 'cucumber.js')

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function numericArgument(flag: string, fallback: number): number {
  const value = argumentValue(flag)
  return value === undefined ? fallback : Number(value)
}

function durationMilliseconds(duration: Duration | undefined): number {
  if (!duration) {
    return 0
  }
  return duration.seconds * 1000 + duration.nanos / 1_000_000
}

async function executeCucumber(iteration: number, outputDirectory: string): Promise<void> {
  const messagesPath = path.join(outputDirectory, `cucumber-${iteration}.ndjson`)
  await mkdir(outputDirectory, {recursive: true})
  await rm(messagesPath, {force: true})
  const args = [
    '--import',
    'tsx',
    cucumberBin,
    'test/bdd/features/**/*.feature',
    '--import',
    'test/bdd/steps/**/*.ts',
    '--format',
    'progress',
    '--format',
    `"message":"${messagesPath}"`,
    '--tags',
    'not @manual',
  ]
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: root, env: process.env, stdio: 'inherit'})
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0) {
    throw new Error(`Cucumber iteration ${iteration} failed with exit code ${exitCode}`)
  }
}

async function loadObservations(
  iteration: number,
  outputDirectory: string,
): Promise<ReadonlyArray<ScenarioObservation>> {
  const messagesPath = path.join(outputDirectory, `cucumber-${iteration}.ndjson`)
  const query = new Query()
  const raw = await readFile(messagesPath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      query.update(parseEnvelope(line))
    }
  }
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
    throw new Error(`Cucumber iteration ${iteration} produced no scenario observations`)
  }
  return observations.sort(
    (left, right) =>
      left.feature.localeCompare(right.feature) || left.scenario.localeCompare(right.scenario),
  )
}

function scenarioRunnerLayer(outputDirectory: string) {
  return Layer.succeed(ScenarioRunnerTag, {
    run: (iteration: number) =>
      Effect.tryPromise({
        try: async () => {
          await executeCucumber(iteration, outputDirectory)
          return loadObservations(iteration, outputDirectory)
        },
        catch: (error) =>
          new ScenarioRunFailure({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
  })
}

function artifactWriterLayer(outputDirectory: string) {
  return Layer.succeed(ExperimentArtifactWriterTag, {
    write: (result: PersonaExperimentResult) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(outputDirectory, {recursive: true})
          await Promise.all([
            writeFile(
              path.join(outputDirectory, 'persona-experiment.md'),
              renderExperimentReport(result),
              'utf8',
            ),
            writeFile(
              path.join(outputDirectory, 'persona-actions.jsonl'),
              `${renderTraceJsonl(result)}\n`,
              'utf8',
            ),
            writeFile(
              path.join(outputDirectory, 'persona-experiment.json'),
              `${JSON.stringify(result, null, 2)}\n`,
              'utf8',
            ),
          ])
        },
        catch: (error) =>
          new ExperimentArtifactFailure({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
  })
}

const outputDirectory = path.resolve(argumentValue('--output-dir') ?? defaultOutputDirectory)
const program = Effect.gen(function* () {
  const config = yield* decodeExperimentConfig({
    iterations: numericArgument('--iterations', 3),
    optimizationStep: numericArgument('--optimization-step', 0.2),
    painThreshold: numericArgument('--pain-threshold', 40),
  })
  const result = yield* runPersonaExperiment(config)
  const finalMetrics = result.iterations.at(-1)?.metrics
  console.log(`Persona experiment report: ${path.join(outputDirectory, 'persona-experiment.md')}`)
  console.log(`Complete action trace: ${path.join(outputDirectory, 'persona-actions.jsonl')}`)
  if (finalMetrics) {
    console.log(
      `Iteration ${finalMetrics.iteration}: mean friction ${finalMetrics.meanFriction.toFixed(1)}, ${finalMetrics.unintuitiveActions} unintuitive actions, ${finalMetrics.highHarmActions} high-harm actions`,
    )
  }
}).pipe(
  Effect.provide(
    Layer.mergeAll(scenarioRunnerLayer(outputDirectory), artifactWriterLayer(outputDirectory)),
  ),
)

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause))
  process.exitCode = 1
}
