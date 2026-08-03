import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  initialSandboxShellState,
  reduceSandboxShell,
  renderSandboxHelp,
  runSandboxShell,
  sandboxConfigFormState,
  SandboxShellFailure,
  SandboxShellRunnerTag,
  SandboxShellSurfaceTag,
  toConsoleScenario,
  type SandboxShellState,
} from '../../../src/sandbox/shell.js'
import type {SandboxCatalog, SandboxScenario} from '../../../src/sandbox/schema.js'
import type {
  SandboxConsoleRunSummary,
  SandboxConsoleScenario,
} from '../../../src/ui/sandbox-console.js'
import type {
  ConfigFormContext,
  ConfigFormField,
  MigrationConfigSelection,
} from '../../../src/ui/config-form.js'
import {configFormFields, configFormProblems} from '../../../src/ui/config-form.js'
import {decodeTerminalKey, makeScriptedTerminalInputLayer} from '../../../src/ui/terminal-input.js'

function scenario(id: string, mode: 'dry-run' | 'apply' = 'dry-run'): SandboxScenario {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    gherkin: `sandbox/migration.feature:${id}`,
    tags: [],
    mode,
    scope: {
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
    },
    interactions: [],
    approvals: [],
    expected: {outcome: 'success'},
  }
}

const catalog: SandboxCatalog = {
  version: 1,
  scenarios: [scenario('alpha'), scenario('beta'), scenario('gamma', 'apply')],
}

interface Recorded {
  readonly browse: Array<{selectedIndex: number; lastRun?: SandboxConsoleRunSummary}>
  readonly guide: number[]
  readonly configure: Array<{focusedIndex: number; context: ConfigFormContext}>
  readonly results: string[]
  readonly runs: string[]
  readonly selections: MigrationConfigSelection[]
}

/** Keystrokes an operator has to type to fill in and start a dry-run migration themselves. */
const OPERATOR_CONFIGURATION: readonly string[] = [
  ...'https://dev.azure.com/contoso',
  '\r',
  ...'Platform',
  '\r',
  ...'contoso',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
  '\r',
]

function testLayers(keys: readonly string[], recorded: Recorded, failRun?: string) {
  const surface = Layer.succeed(SandboxShellSurfaceTag, {
    showScenarios: (
      _scenarios: readonly SandboxConsoleScenario[],
      selectedIndex: number,
      lastRun: SandboxConsoleRunSummary | undefined,
    ) =>
      Effect.sync(() => {
        recorded.browse.push({selectedIndex, ...(lastRun ? {lastRun} : {})})
      }),
    showGuide: (lines: readonly string[]) =>
      Effect.sync(() => {
        recorded.guide.push(lines.length)
      }),
    showConfigure: (
      _fields: readonly ConfigFormField[],
      focusedIndex: number,
      context: ConfigFormContext,
    ) =>
      Effect.sync(() => {
        recorded.configure.push({focusedIndex, context})
      }),
    showResult: (summary: SandboxConsoleRunSummary) =>
      Effect.sync(() => {
        recorded.results.push(summary.scenarioId)
      }),
  })
  const runner = Layer.succeed(SandboxShellRunnerTag, {
    run: (target: SandboxScenario, selection: MigrationConfigSelection) =>
      target.id === failRun
        ? Effect.fail(
            new SandboxShellFailure({
              operation: 'run-scenario',
              reason: 'scenario-failed',
              scenarioId: target.id,
            }),
          )
        : Effect.sync(() => {
            recorded.runs.push(target.id)
            recorded.selections.push(selection)
            return {
              scenarioId: target.id,
              status: 'completed' as const,
              headline: `${target.id} complete`,
              detail: 'synthetic providers',
            }
          }),
  })
  return Layer.mergeAll(surface, runner, makeScriptedTerminalInputLayer(keys))
}

function emptyRecorded(): Recorded {
  return {browse: [], guide: [], configure: [], results: [], runs: [], selections: []}
}

describe('sandbox shell reducer', () => {
  const state: SandboxShellState = {panel: 'scenarios', selectedIndex: 0}

  it('preselects a supplied scenario without producing a run command', () => {
    expect(initialSandboxShellState(catalog, 'gamma')).toEqual({
      panel: 'scenarios',
      selectedIndex: 2,
    })
    expect(initialSandboxShellState(catalog, 'missing')).toEqual({
      panel: 'scenarios',
      selectedIndex: 0,
    })
  })

  it('moves the selection without starting a run', () => {
    const next = reduceSandboxShell(state, decodeTerminalKey('j'), catalog.scenarios)
    expect(next.command).toEqual({_tag: 'render'})
    expect(next.state.selectedIndex).toBe(1)

    const wrapped = reduceSandboxShell(next.state, decodeTerminalKey('\u001b[B'), catalog.scenarios)
    expect(wrapped.state.selectedIndex).toBe(2)
    expect(
      reduceSandboxShell(wrapped.state, decodeTerminalKey('\u001b[B'), catalog.scenarios).state
        .selectedIndex,
    ).toBe(0)
    expect(
      reduceSandboxShell(state, decodeTerminalKey('\u001b[A'), catalog.scenarios).state
        .selectedIndex,
    ).toBe(2)
    expect(
      reduceSandboxShell(state, decodeTerminalKey('\u001b[F'), catalog.scenarios).state
        .selectedIndex,
    ).toBe(2)
    expect(
      reduceSandboxShell(
        {panel: 'scenarios', selectedIndex: 2},
        decodeTerminalKey('\u001b[H'),
        catalog.scenarios,
      ).state.selectedIndex,
    ).toBe(0)
  })

  it('opens the configuration form on confirmation instead of starting a run', () => {
    const opened = reduceSandboxShell(state, decodeTerminalKey('\r'), catalog.scenarios)
    expect(opened.command).toEqual({_tag: 'render'})
    expect(opened.state.panel).toBe('configure')
    expect(opened.state.form?.values).toMatchObject({
      adoOrg: '',
      adoProject: '',
      githubOrg: '',
      execution: 'dry-run',
    })
    expect(opened.state.form?.context.fixtureScope?.adoOrg).toBe('https://dev.azure.com/contoso')

    const guided = reduceSandboxShell(state, decodeTerminalKey('g'), catalog.scenarios)
    expect(guided.state.panel).toBe('guide')
    expect(guided.command).toEqual({_tag: 'render'})

    const confirmedInGuide = reduceSandboxShell(
      guided.state,
      decodeTerminalKey('\r'),
      catalog.scenarios,
    )
    expect(confirmedInGuide.command).toEqual({_tag: 'render'})
    expect(confirmedInGuide.state.panel).toBe('scenarios')
  })

  it('keeps typed characters in the form instead of treating them as menu shortcuts', () => {
    let current = reduceSandboxShell(state, decodeTerminalKey('\r'), catalog.scenarios).state
    for (const character of 'qjg') {
      const transition = reduceSandboxShell(
        current,
        decodeTerminalKey(character),
        catalog.scenarios,
      )
      expect(transition.command).toEqual({_tag: 'render'})
      current = transition.state
    }

    expect(current.panel).toBe('configure')
    expect(current.form?.values.adoOrg).toBe('qjg')
  })

  it('refuses to start until every operator-supplied value is valid', () => {
    const opened = reduceSandboxShell(state, decodeTerminalKey('\r'), catalog.scenarios).state
    const focusedOnStart: SandboxShellState = {
      ...opened,
      form: {
        ...opened.form!,
        focusedIndex: configFormFields(opened.form!).length - 1,
      },
    }
    const rejected = reduceSandboxShell(focusedOnStart, decodeTerminalKey('\r'), catalog.scenarios)

    expect(rejected.command).toEqual({_tag: 'render'})
    expect(rejected.state.form?.showProblems).toBe(true)
    expect(configFormProblems(rejected.state.form!)).toContain(
      'Azure DevOps organization: Required. Example: https://dev.azure.com/contoso',
    )
  })

  it('returns to the scenario list when the form is cancelled', () => {
    const opened = reduceSandboxShell(state, decodeTerminalKey('\r'), catalog.scenarios).state
    const cancelled = reduceSandboxShell(opened, decodeTerminalKey('\u001b'), catalog.scenarios)

    expect(cancelled.command).toEqual({_tag: 'render'})
    expect(cancelled.state).toEqual({panel: 'scenarios', selectedIndex: 0})
  })

  it('returns to the scenario list from a run result without starting another run', () => {
    const resultState: SandboxShellState = {panel: 'result', selectedIndex: 1}
    const dismissed = reduceSandboxShell(resultState, decodeTerminalKey('\r'), catalog.scenarios)

    expect(dismissed.command).toEqual({_tag: 'render'})
    expect(dismissed.state).toEqual({panel: 'scenarios', selectedIndex: 1})
    expect(
      reduceSandboxShell(resultState, decodeTerminalKey('q'), catalog.scenarios).command,
    ).toEqual({_tag: 'exit'})
  })

  it('reopens the last run result on demand without starting another run', () => {
    const lastRun = {
      scenarioId: 'happy-path',
      status: 'completed' as const,
      headline: 'happy-path completed',
      detail: 'Report sandbox-report-happy-path.md',
    }
    const browsing: SandboxShellState = {panel: 'scenarios', selectedIndex: 1, lastRun}
    const reopened = reduceSandboxShell(browsing, decodeTerminalKey('r'), catalog.scenarios)

    expect(reopened.command).toEqual({_tag: 'render'})
    expect(reopened.state.panel).toBe('result')
    expect(reopened.state.lastRun).toBe(lastRun)

    const withoutHistory = reduceSandboxShell(
      {panel: 'scenarios', selectedIndex: 1},
      decodeTerminalKey('r'),
      catalog.scenarios,
    )

    expect(withoutHistory.command).toEqual({_tag: 'render'})
    expect(withoutHistory.state.panel).toBe('scenarios')
  })

  it('exits only on an explicit exit key', () => {
    expect(reduceSandboxShell(state, decodeTerminalKey('q'), catalog.scenarios).command).toEqual({
      _tag: 'exit',
    })
    expect(
      reduceSandboxShell(state, decodeTerminalKey('\u0003'), catalog.scenarios).command,
    ).toEqual({_tag: 'exit'})
    expect(reduceSandboxShell(state, decodeTerminalKey('z'), catalog.scenarios).command).toEqual({
      _tag: 'render',
    })
  })
})

describe('runSandboxShell', () => {
  it('never starts a scenario without an operator confirmation', async () => {
    const recorded = emptyRecorded()

    const result = await Effect.runPromise(
      runSandboxShell(catalog, {initialScenarioId: 'gamma'}).pipe(
        Effect.provide(testLayers(['j', '\u001b[A', 'q'], recorded)),
      ),
    )

    expect(result.startedScenarios).toEqual([])
    expect(recorded.runs).toEqual([])
    expect(recorded.browse.map((entry) => entry.selectedIndex)).toEqual([2, 0, 2])
  })

  it('keeps the surface mounted across runs and exits only on the explicit exit key', async () => {
    const recorded = emptyRecorded()

    const result = await Effect.runPromise(
      runSandboxShell(catalog).pipe(
        Effect.provide(
          testLayers(
            ['\r', ...OPERATOR_CONFIGURATION, '\r', 'j', '\r', ...OPERATOR_CONFIGURATION, 'q'],
            recorded,
          ),
        ),
      ),
    )

    expect(recorded.runs).toEqual(['alpha', 'beta'])
    expect(result.startedScenarios).toEqual(['alpha', 'beta'])
    expect(result.lastRun?.scenarioId).toBe('beta')
    expect(recorded.results).toEqual(['alpha', 'beta'])
    expect(recorded.selections[0]).toEqual({
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      apply: false,
      concurrency: 4,
    })
    expect(recorded.browse.at(-1)?.lastRun?.scenarioId).toBe('alpha')
  })

  it('opens the configuration form and starts nothing when the operator cancels it', async () => {
    const recorded = emptyRecorded()

    const result = await Effect.runPromise(
      runSandboxShell(catalog).pipe(
        Effect.provide(testLayers(['\r', ...'contoso', '\u001b', 'q'], recorded)),
      ),
    )

    expect(result.startedScenarios).toEqual([])
    expect(recorded.runs).toEqual([])
    expect(recorded.configure.length).toBeGreaterThan(1)
    expect(recorded.configure[0]?.context.scenarioId).toBe('alpha')
    expect(recorded.browse.at(-1)?.lastRun).toBeUndefined()
  })

  it('renders the guide inside the same surface without leaving the session', async () => {
    const recorded = emptyRecorded()

    await Effect.runPromise(
      runSandboxShell(catalog).pipe(Effect.provide(testLayers(['g', 'g', 'q'], recorded))),
    )

    expect(recorded.guide).toHaveLength(1)
    expect(recorded.browse).toHaveLength(2)
    expect(recorded.runs).toEqual([])
  })

  it('surfaces a typed failure when input is unavailable instead of silently exiting', async () => {
    const recorded = emptyRecorded()

    const failure = await Effect.runPromise(
      Effect.flip(runSandboxShell(catalog).pipe(Effect.provide(testLayers([], recorded)))),
    )

    expect(failure).toMatchObject({
      _tag: 'SandboxShellFailure',
      operation: 'read-input',
      reason: 'input-unavailable',
    })
  })

  it('surfaces a typed failure when a confirmed run fails', async () => {
    const recorded = emptyRecorded()

    const failure = await Effect.runPromise(
      Effect.flip(
        runSandboxShell(catalog).pipe(
          Effect.provide(testLayers(['\r', ...OPERATOR_CONFIGURATION], recorded, 'alpha')),
        ),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'SandboxShellFailure',
      reason: 'scenario-failed',
      scenarioId: 'alpha',
    })
  })

  it('rejects an empty catalog with a typed failure', async () => {
    const recorded = emptyRecorded()

    const failure = await Effect.runPromise(
      Effect.flip(
        runSandboxShell({version: 1, scenarios: []}).pipe(
          Effect.provide(testLayers(['q'], recorded)),
        ),
      ),
    )

    expect(failure).toMatchObject({reason: 'empty-catalog'})
  })
})

describe('sandbox help', () => {
  it('documents the mounted surface and the one-shot automation form', () => {
    const help = renderSandboxHelp(catalog)

    expect(help).toContain('One terminal surface stays mounted from launch until you exit it.')
    expect(help).toContain(
      'screen is entered once for the session and left once, never per scenario.',
    )
    expect(help).toContain('r reopens the last run result')
    expect(help).toContain('never advance the interface on your behalf')
    expect(help).toContain('Preselect a scenario in the list; it never starts on its own.')
    expect(help).toContain('You supply every migration input yourself')
    expect(help).toContain('Enter opens the migration')
    expect(help).toContain('"Start migration" row begins the run once every field is valid')
    expect(help).toContain('a2g migrate --sandbox <scenario>')
    expect(help).toContain('alpha [dry-run]')
    expect(help).toContain('gamma [apply]')
    expect(help).not.toContain('Exit sandbox')
  })

  it('seeds the configuration form without filling the migration in for the operator', () => {
    const form = sandboxConfigFormState(scenario('gamma', 'apply'))

    expect(form.values.adoOrg).toBe('')
    expect(form.values.adoProject).toBe('')
    expect(form.values.githubOrg).toBe('')
    expect(form.values.execution).toBe('apply')
    expect(form.showProblems).toBe(false)
    expect(form.context.allowTopology).toBe(false)
    expect(configFormFields(form).some((field) => field.id === 'start')).toBe(true)
  })

  it('projects catalog scenarios onto the console list contract', () => {
    expect(toConsoleScenario(scenario('alpha'))).toEqual({
      id: 'alpha',
      title: 'alpha title',
      description: 'alpha description',
      mode: 'dry-run',
      scope: 'https://dev.azure.com/contoso/Platform → contoso',
      expectation: 'Predetermined service result: completes successfully.',
    })
  })
})
