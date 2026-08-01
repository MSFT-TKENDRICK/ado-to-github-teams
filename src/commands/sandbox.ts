import {select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import {Effect, Layer} from 'effect'
import {findSandboxScenario, loadSandboxCatalog} from '../sandbox/config.js'
import {
  SANDBOX_EXIT_SELECTION,
  SANDBOX_GUIDE_SELECTION,
  SandboxScenarioRunnerTag,
  SandboxSessionFailure,
  SandboxSessionUiTag,
  runSandboxSession,
  sandboxMigrationArgs,
} from '../sandbox/interactive-session.js'
import {DEFAULT_PRESENTATION_MODE} from '../ui/adaptive-detail.js'

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError'
}

export default class Sandbox extends Command {
  static override description =
    'Open a persistent interactive CLI session with simulated provider services'

  static override examples = [
    {
      description: 'Explore predefined scenarios until you explicitly exit',
      command: '<%= config.bin %> <%= command.id %>',
    },
    {
      description: 'Use a custom synthetic scenario catalog',
      command: '<%= config.bin %> <%= command.id %> --sandbox-config ./scenarios.yaml',
    },
    {
      description: 'Highlight a scenario initially without running it automatically',
      command: '<%= config.bin %> <%= command.id %> --scenario happy-path',
    },
  ]

  static override flags = {
    'sandbox-config': Flags.string({
      description: 'Scenario YAML path (default: bundled catalog)',
      required: false,
    }),
    scenario: Flags.string({
      description: 'Scenario to highlight initially; selection still requires operator input',
      required: false,
    }),
    detail: Flags.string({
      description: 'Presentation detail: guided orientation or compact scanning',
      options: ['guided', 'compact'],
      default: DEFAULT_PRESENTATION_MODE,
    }),
    tui: Flags.boolean({
      description: 'Use the animated interactive terminal dashboard when supported',
      default: true,
      allowNo: true,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Sandbox)
    const loaded = await Effect.runPromise(loadSandboxCatalog(flags['sandbox-config']))
    const initialScenario =
      flags.scenario !== undefined
        ? await Effect.runPromise(findSandboxScenario(loaded.catalog, flags.scenario))
        : undefined
    const layer = Layer.merge(
      Layer.succeed(SandboxSessionUiTag, {
        choose: (scenarios, defaultScenarioId) =>
          Effect.tryPromise({
            try: async () => {
              try {
                return await select({
                  message: 'What would you like to explore?',
                  choices: [
                    ...scenarios.map((scenario) => ({
                      name: `${scenario.title} (${scenario.mode})`,
                      value: scenario.id,
                      description: scenario.description,
                    })),
                    {
                      name: 'Show scenario guide',
                      value: SANDBOX_GUIDE_SELECTION,
                      description: 'Explain every predetermined provider scenario and outcome.',
                    },
                    {
                      name: 'Exit sandbox',
                      value: SANDBOX_EXIT_SELECTION,
                      description: 'Close this interactive sandbox session.',
                    },
                  ],
                  ...(defaultScenarioId ? {default: defaultScenarioId} : {}),
                })
              } catch (error) {
                if (isPromptCancellation(error)) {
                  return SANDBOX_EXIT_SELECTION
                }
                throw error
              }
            },
            catch: () =>
              new SandboxSessionFailure({
                operation: 'choose-action',
                reason: 'prompt-failed',
              }),
          }),
        writeLine: (line) => Effect.sync(() => this.log(line)),
      }),
      Layer.succeed(SandboxScenarioRunnerTag, {
        run: (scenario) =>
          Effect.tryPromise({
            try: () =>
              this.config.runCommand(
                'migrate',
                sandboxMigrationArgs(scenario, {
                  ...(flags['sandbox-config'] ? {configPath: flags['sandbox-config']} : {}),
                  detail: flags.detail,
                  tui: flags.tui,
                }),
              ),
            catch: () =>
              new SandboxSessionFailure({
                operation: 'run-scenario',
                reason: 'scenario-command-failed',
                scenarioId: scenario.id,
              }),
          }).pipe(Effect.asVoid),
      }),
    )

    await Effect.runPromise(
      runSandboxSession(loaded.catalog, {
        ...(initialScenario ? {initialScenarioId: initialScenario.id} : {}),
      }).pipe(Effect.provide(layer)),
    )
  }
}
