import {Context, Data, Effect} from 'effect'
import type {SandboxCatalog, SandboxScenario} from './schema.js'

export const SANDBOX_GUIDE_SELECTION = '__sandbox-guide__'
export const SANDBOX_EXIT_SELECTION = '__sandbox-exit__'

export class SandboxSessionFailure extends Data.TaggedError('SandboxSessionFailure')<{
  readonly operation: 'choose-action' | 'run-scenario'
  readonly reason: 'prompt-failed' | 'scenario-command-failed' | 'unknown-selection'
  readonly scenarioId?: string
}> {}

export interface SandboxSessionUi {
  readonly choose: (
    scenarios: readonly SandboxScenario[],
    defaultScenarioId: string | undefined,
  ) => Effect.Effect<string, SandboxSessionFailure>
  readonly writeLine: (line: string) => Effect.Effect<void>
}

export interface SandboxScenarioRunner {
  readonly run: (scenario: SandboxScenario) => Effect.Effect<void, SandboxSessionFailure>
}

export class SandboxSessionUiTag extends Context.Tag('SandboxSessionUi')<
  SandboxSessionUiTag,
  SandboxSessionUi
>() {}

export class SandboxScenarioRunnerTag extends Context.Tag('SandboxScenarioRunner')<
  SandboxScenarioRunnerTag,
  SandboxScenarioRunner
>() {}

function scenarioOutcome(scenario: SandboxScenario): string {
  return scenario.expected.outcome === 'success'
    ? 'completes successfully'
    : `surfaces the expected ${scenario.expected.failureService} ${scenario.expected.failureType}`
}

export function renderSandboxScenarioGuide(catalog: SandboxCatalog): readonly string[] {
  return [
    'Sandbox scenario contracts:',
    ...catalog.scenarios.flatMap((scenario) => [
      `  ${scenario.id} [${scenario.mode}]`,
      `    ${scenario.title}: ${scenario.description}`,
      `    Predetermined service result: ${scenarioOutcome(scenario)}.`,
    ]),
  ]
}

export function renderSandboxHelp(catalog: SandboxCatalog): string {
  return [
    'a2g sandbox - explore the real CLI with simulated provider services',
    '',
    'USAGE',
    '  a2g sandbox [--scenario <scenario>]',
    '  a2g --sandbox',
    '  a2g --sandbox <scenario>',
    '',
    'OPTIONS',
    '  --sandbox-config <path>  Use a custom synthetic scenario catalog.',
    '  --scenario <scenario>    Highlight a validated scenario initially; never autoplay it.',
    '  --detail <mode>          Use guided (default) or compact presentation.',
    '  --no-tui                 Use stable line-oriented progress output.',
    '',
    'INTERACTIVE SESSION',
    '  The sandbox shell remains open until you choose Exit sandbox or press Ctrl+C.',
    '  Select scenarios repeatedly; each run uses the production migration, approval,',
    '  reporting, recovery-guidance, and terminal-dashboard interfaces.',
    '  Only ADO, Entra, and GitHub service boundaries use predetermined responses.',
    '  Apply scenarios automatically use apply mode and still show real approval prompts.',
    '  A scenario supplied to the shell is only the initial highlighted choice.',
    '',
    'ONE-SHOT AUTOMATION',
    '  Use a2g migrate --sandbox <scenario> to run once and return to the caller.',
    "  Add --apply for apply scenarios; --yes accepts that scenario's predefined decisions.",
    '',
    ...renderSandboxScenarioGuide(catalog),
  ].join('\n')
}

export function sandboxMigrationArgs(
  scenario: SandboxScenario,
  options: {
    readonly configPath?: string
    readonly detail: string
    readonly tui: boolean
  },
): string[] {
  return [
    '--sandbox',
    scenario.id,
    ...(scenario.mode === 'apply' ? ['--apply'] : []),
    ...(options.configPath ? ['--sandbox-config', options.configPath] : []),
    ...(options.detail === 'guided' ? [] : ['--detail', options.detail]),
    ...(options.tui ? [] : ['--no-tui']),
  ]
}

export function runSandboxSession(
  catalog: SandboxCatalog,
  options: {readonly initialScenarioId?: string} = {},
): Effect.Effect<void, SandboxSessionFailure, SandboxSessionUiTag | SandboxScenarioRunnerTag> {
  return Effect.gen(function* () {
    const ui = yield* SandboxSessionUiTag
    const runner = yield* SandboxScenarioRunnerTag
    let defaultScenarioId = options.initialScenarioId

    yield* ui.writeLine(
      'Interactive sandbox started. Provider services are simulated; the CLI is real.',
    )
    yield* ui.writeLine('Choose scenarios as often as you like. Select Exit sandbox when finished.')

    while (true) {
      const selection = yield* ui.choose(catalog.scenarios, defaultScenarioId)
      defaultScenarioId = undefined
      if (selection === SANDBOX_EXIT_SELECTION) {
        yield* ui.writeLine('Sandbox session closed.')
        return
      }
      if (selection === SANDBOX_GUIDE_SELECTION) {
        for (const line of renderSandboxScenarioGuide(catalog)) {
          yield* ui.writeLine(line)
        }
        continue
      }

      const scenario = catalog.scenarios.find((candidate) => candidate.id === selection)
      if (!scenario) {
        return yield* Effect.fail(
          new SandboxSessionFailure({
            operation: 'choose-action',
            reason: 'unknown-selection',
          }),
        )
      }
      yield* runner.run(scenario)
    }
  })
}
