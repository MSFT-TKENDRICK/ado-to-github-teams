import {confirm} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {Effect, Layer} from 'effect'
import {findSandboxScenario, loadSandboxCatalog} from '../sandbox/config.js'
import {
  runSandboxScenario,
  sandboxCheckpointDirectory,
  sandboxDashboardState,
  sandboxReportPath,
  sandboxScenarioRunId,
  sandboxScenarioScope,
} from '../sandbox/scenario-run.js'
import {
  SandboxShellRunnerTag,
  SandboxShellSurfaceTag,
  runSandboxShell,
  toConsoleScenario,
} from '../sandbox/shell.js'
import {approvalPrompt} from '../ui/approval-context.js'
import {renderMigrationCompletion} from '../ui/outcome-confirmation.js'
import {renderRecoveryGuidance} from '../ui/recovery-guidance.js'
import {SandboxConsole, type SandboxConsoleRunSummary} from '../ui/sandbox-console.js'
import {makeTerminalInputLayer} from '../ui/terminal-input.js'
import {TerminalMigrationPresentation} from '../ui/migration-presentation.js'
import {supportsInteractiveTui} from '../ui/terminal-dashboard.js'

export default class Sandbox extends Command {
  static override description =
    'Drive a persistent interactive CLI session with simulated provider services'

  static override examples = [
    {
      description: 'Open the sandbox surface and choose scenarios yourself',
      command: '<%= config.bin %> <%= command.id %>',
    },
    {
      description: 'Use a custom synthetic scenario catalog',
      command: '<%= config.bin %> <%= command.id %> --sandbox-config ./scenarios.yaml',
    },
    {
      description: 'Preselect a scenario without starting it',
      command: '<%= config.bin %> <%= command.id %> --scenario happy-path',
    },
  ]

  static override flags = {
    'sandbox-config': Flags.string({
      description: 'Scenario YAML path (default: bundled catalog)',
      required: false,
    }),
    scenario: Flags.string({
      description: 'Scenario to preselect; starting a run still requires operator input',
      required: false,
    }),
    tui: Flags.boolean({
      description: 'Use the framed interactive surface when the terminal supports it',
      default: true,
      allowNo: true,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Sandbox)
    if (process.stdin.isTTY !== true || !supportsInteractiveTui(process.stdout)) {
      this.error(
        [
          'The sandbox session needs an interactive terminal for both keyboard input and output.',
          'Run it from a terminal, or use the noninteractive one-shot forms:',
          '  a2g migrate --sandbox <scenario>',
          '  a2g --list-sandbox-scenarios',
        ].join('\n'),
        {exit: 2},
      )
    }

    const loaded = await Effect.runPromise(loadSandboxCatalog(flags['sandbox-config']))
    const initialScenario =
      flags.scenario === undefined
        ? undefined
        : await Effect.runPromise(findSandboxScenario(loaded.catalog, flags.scenario))
    const surface = new SandboxConsole(
      {
        _tag: 'browse',
        scenarios: loaded.catalog.scenarios.map(toConsoleScenario),
        selectedIndex: 0,
      },
      {enabled: flags.tui},
    )

    const layer = Layer.mergeAll(
      Layer.succeed(SandboxShellSurfaceTag, {
        showScenarios: (scenarios, selectedIndex, lastRun) =>
          Effect.sync(() => {
            surface.show({
              _tag: 'browse',
              scenarios,
              selectedIndex,
              ...(lastRun ? {lastRun} : {}),
            })
          }),
        showGuide: (lines) => Effect.sync(() => surface.show({_tag: 'guide', lines})),
        showConfigure: (fields, focusedIndex, context) =>
          Effect.sync(() => surface.show({_tag: 'configure', fields, focusedIndex, context})),
        showResult: (summary) => Effect.sync(() => surface.show({_tag: 'result', summary})),
      }),
      Layer.succeed(SandboxShellRunnerTag, {
        run: (scenario, selection) => {
          const runId = sandboxScenarioRunId(scenario.id)
          const scope = sandboxScenarioScope(scenario, {
            adoOrg: selection.adoOrg,
            adoProject: selection.adoProject,
            githubOrg: selection.githubOrg,
          })
          const apply = selection.apply
          const output = selection.output ?? sandboxReportPath(scenario.id)
          const state = sandboxDashboardState({runId, scope, apply})
          const presentation = new TerminalMigrationPresentation(state, {
            surface: surface.runSurface(scenario.id, state),
          })
          const transcript: string[] = []
          return runSandboxScenario({
            scenario,
            configDigest: loaded.digest,
            presentation,
            runId,
            scope,
            apply,
            yes: false,
            concurrency: selection.concurrency,
            output,
            checkpointDirectory: sandboxCheckpointDirectory(scenario.id, runId),
            ...(selection.prefix ? {prefix: selection.prefix} : {}),
            ...(selection.suffix ? {suffix: selection.suffix} : {}),
            writeLine: (line) => {
              transcript.push(line)
            },
            confirmApproval: async (request) =>
              confirm({message: approvalPrompt(request), default: false}),
          }).pipe(
            Effect.map((outcome): SandboxConsoleRunSummary =>
              outcome._tag === 'completed'
                ? {
                    scenarioId: scenario.id,
                    status: 'completed',
                    headline: `${scenario.id} completed`,
                    detail: `Report ${outcome.reportPath}`,
                    lines: [
                      ...transcript,
                      ...renderMigrationCompletion({
                        runId: outcome.runId,
                        reportPath: outcome.reportPath,
                        apply,
                        sandboxScenario: scenario.id,
                      }),
                    ],
                  }
                : {
                    scenarioId: scenario.id,
                    status: 'completed',
                    headline: `${scenario.id} reached its expected ${outcome.failureTag}`,
                    detail: outcome.message,
                    lines: [
                      ...transcript,
                      `Scenario reached its expected failure: ${outcome.message}`,
                    ],
                  },
            ),
            Effect.catchAll((failure) =>
              Effect.succeed<SandboxConsoleRunSummary>({
                scenarioId: scenario.id,
                status: 'failed',
                headline: `${scenario.id} stopped with ${failure._tag}`,
                detail: failure.message,
                lines: [
                  ...transcript,
                  ...renderRecoveryGuidance(failure, ['migrate', '--sandbox', scenario.id]).split(
                    '\n',
                  ),
                ],
              }),
            ),
          )
        },
      }),
      makeTerminalInputLayer(process.stdin),
    )

    surface.open()
    try {
      await Effect.runPromise(
        runSandboxShell(loaded.catalog, {
          ...(initialScenario ? {initialScenarioId: initialScenario.id} : {}),
        }).pipe(Effect.provide(layer)),
      )
    } finally {
      surface.close()
    }
    this.log(chalk.green('Sandbox session closed. No provider writes were performed.'))
  }
}
