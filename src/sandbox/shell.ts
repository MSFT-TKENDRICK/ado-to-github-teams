import {Context, Data, Effect} from 'effect'
import {TerminalInputTag, type TerminalKey} from '../ui/terminal-input.js'
import type {SandboxConsoleRunSummary, SandboxConsoleScenario} from '../ui/sandbox-console.js'
import type {SandboxCatalog, SandboxScenario} from './schema.js'

export class SandboxShellFailure extends Data.TaggedError('SandboxShellFailure')<{
  readonly operation: 'read-input' | 'render' | 'run-scenario'
  readonly reason: 'input-unavailable' | 'surface-failed' | 'scenario-failed' | 'empty-catalog'
  readonly scenarioId?: string
  readonly detail?: string
}> {}

export interface SandboxShellSurface {
  readonly showScenarios: (
    scenarios: readonly SandboxConsoleScenario[],
    selectedIndex: number,
    lastRun: SandboxConsoleRunSummary | undefined,
  ) => Effect.Effect<void, SandboxShellFailure>
  readonly showGuide: (lines: readonly string[]) => Effect.Effect<void, SandboxShellFailure>
  readonly showResult: (
    summary: SandboxConsoleRunSummary,
  ) => Effect.Effect<void, SandboxShellFailure>
}

export interface SandboxShellRunner {
  readonly run: (
    scenario: SandboxScenario,
  ) => Effect.Effect<SandboxConsoleRunSummary, SandboxShellFailure>
}

export class SandboxShellSurfaceTag extends Context.Tag('SandboxShellSurface')<
  SandboxShellSurfaceTag,
  SandboxShellSurface
>() {}

export class SandboxShellRunnerTag extends Context.Tag('SandboxShellRunner')<
  SandboxShellRunnerTag,
  SandboxShellRunner
>() {}

export type SandboxShellPanel = 'scenarios' | 'guide' | 'result'

export interface SandboxShellState {
  readonly panel: SandboxShellPanel
  readonly selectedIndex: number
  readonly lastRun?: SandboxConsoleRunSummary
}

export type SandboxShellCommand =
  | {readonly _tag: 'render'}
  | {readonly _tag: 'start-run'; readonly scenarioId: string}
  | {readonly _tag: 'exit'}

export interface SandboxShellTransition {
  readonly state: SandboxShellState
  readonly command: SandboxShellCommand
}

export interface SandboxShellResult {
  readonly startedScenarios: readonly string[]
  readonly lastRun?: SandboxConsoleRunSummary
}

export function scenarioExpectation(scenario: SandboxScenario): string {
  return scenario.expected.outcome === 'success'
    ? 'completes successfully'
    : `surfaces the expected ${scenario.expected.failureService} ${scenario.expected.failureType}`
}

export function toConsoleScenario(scenario: SandboxScenario): SandboxConsoleScenario {
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    mode: scenario.mode,
    scope: `${scenario.scope.adoOrg}/${scenario.scope.adoProject} → ${scenario.scope.githubOrg}`,
    expectation: `Predetermined service result: ${scenarioExpectation(scenario)}.`,
  }
}

export function initialSandboxShellState(
  catalog: SandboxCatalog,
  initialScenarioId?: string,
): SandboxShellState {
  const index = catalog.scenarios.findIndex((scenario) => scenario.id === initialScenarioId)
  return {panel: 'scenarios', selectedIndex: index >= 0 ? index : 0}
}

/**
 * Pure keyboard reducer for the persistent sandbox shell. A migration only ever begins through an
 * explicit `start-run` command, which only `confirm` on the scenario panel can produce.
 */
export function reduceSandboxShell(
  state: SandboxShellState,
  key: TerminalKey,
  scenarios: readonly SandboxScenario[],
): SandboxShellTransition {
  const total = scenarios.length
  const clamp = (index: number): number => (total === 0 ? 0 : ((index % total) + total) % total)

  if (key.action === 'exit') {
    return {state, command: {_tag: 'exit'}}
  }
  if (state.panel === 'result') {
    return {state: {...state, panel: 'scenarios'}, command: {_tag: 'render'}}
  }
  if (key.action === 'review') {
    return state.lastRun
      ? {state: {...state, panel: 'result'}, command: {_tag: 'render'}}
      : {state, command: {_tag: 'render'}}
  }
  if (key.action === 'guide') {
    return {
      state: {...state, panel: state.panel === 'guide' ? 'scenarios' : 'guide'},
      command: {_tag: 'render'},
    }
  }
  if (state.panel === 'guide') {
    return key.action === 'confirm'
      ? {state: {...state, panel: 'scenarios'}, command: {_tag: 'render'}}
      : {state, command: {_tag: 'render'}}
  }
  switch (key.action) {
    case 'previous':
      return {
        state: {...state, selectedIndex: clamp(state.selectedIndex - 1)},
        command: {_tag: 'render'},
      }
    case 'next':
      return {
        state: {...state, selectedIndex: clamp(state.selectedIndex + 1)},
        command: {_tag: 'render'},
      }
    case 'first':
      return {state: {...state, selectedIndex: 0}, command: {_tag: 'render'}}
    case 'last':
      return {state: {...state, selectedIndex: clamp(total - 1)}, command: {_tag: 'render'}}
    case 'confirm': {
      const scenario = scenarios[state.selectedIndex]
      return scenario
        ? {state, command: {_tag: 'start-run', scenarioId: scenario.id}}
        : {state, command: {_tag: 'render'}}
    }
    default:
      return {state, command: {_tag: 'render'}}
  }
}

export function renderSandboxScenarioGuide(catalog: SandboxCatalog): readonly string[] {
  return [
    'Sandbox scenario contracts:',
    ...catalog.scenarios.flatMap((scenario) => [
      `  ${scenario.id} [${scenario.mode}]`,
      `    ${scenario.title}: ${scenario.description}`,
      `    Predetermined service result: ${scenarioExpectation(scenario)}.`,
    ]),
  ]
}

export function renderSandboxHelp(catalog: SandboxCatalog): string {
  return [
    'a2g sandbox - drive the real CLI interactively with simulated provider services',
    '',
    'USAGE',
    '  a2g sandbox [--scenario <scenario>]',
    '  a2g --sandbox',
    '  a2g --sandbox <scenario>',
    '',
    'OPTIONS',
    '  --sandbox-config <path>  Use a custom synthetic scenario catalog.',
    '  --scenario <scenario>    Preselect a scenario in the list; it never starts on its own.',
    '  --no-tui                 Use stable line-oriented output instead of the framed surface.',
    '',
    'INTERACTIVE SURFACE',
    '  One terminal surface stays mounted from launch until you exit it. The alternate',
    '  screen is entered once for the session and left once, never per scenario.',
    '  ↑/↓ (or k/j) move the selection, Home/End jump, Enter starts the highlighted',
    '  scenario, g shows the scenario contracts, r reopens the last run result,',
    '  q or Ctrl+C exits the session.',
    '  A run renders in the same surface using the production migration dashboard,',
    '  approval prompts, reports, and recovery guidance, then returns to the list.',
    '  Only ADO, Entra, and GitHub service boundaries return predetermined responses;',
    '  scenarios supply deterministic provider state, never an alternate experience,',
    '  and never advance the interface on your behalf.',
    '  The session requires an interactive terminal for both input and output.',
    '',
    'ONE-SHOT AUTOMATION',
    '  Use a2g migrate --sandbox <scenario> to run once and return to the caller.',
    "  Add --apply for apply scenarios; --yes accepts that scenario's predefined decisions.",
    '',
    ...renderSandboxScenarioGuide(catalog),
  ].join('\n')
}

/**
 * Runs the persistent sandbox shell. The loop only terminates on an explicit operator exit, and a
 * scenario is only executed after a `confirm` key on the scenario panel.
 */
export function runSandboxShell(
  catalog: SandboxCatalog,
  options: {readonly initialScenarioId?: string} = {},
): Effect.Effect<
  SandboxShellResult,
  SandboxShellFailure,
  SandboxShellSurfaceTag | SandboxShellRunnerTag | TerminalInputTag
> {
  return Effect.gen(function* () {
    const surface = yield* SandboxShellSurfaceTag
    const runner = yield* SandboxShellRunnerTag
    const input = yield* TerminalInputTag
    const scenarios = catalog.scenarios

    if (scenarios.length === 0) {
      return yield* Effect.fail(
        new SandboxShellFailure({operation: 'render', reason: 'empty-catalog'}),
      )
    }

    const consoleScenarios = scenarios.map(toConsoleScenario)
    const guideLines = renderSandboxScenarioGuide(catalog)
    const startedScenarios: string[] = []
    let state = initialSandboxShellState(catalog, options.initialScenarioId)

    const paint = (current: SandboxShellState) => {
      if (current.panel === 'guide') {
        return surface.showGuide(guideLines)
      }
      if (current.panel === 'result' && current.lastRun) {
        return surface.showResult(current.lastRun)
      }
      return surface.showScenarios(consoleScenarios, current.selectedIndex, current.lastRun)
    }

    yield* paint(state)

    while (true) {
      const key = yield* input.readKey.pipe(
        Effect.mapError(
          (failure) =>
            new SandboxShellFailure({
              operation: 'read-input',
              reason: 'input-unavailable',
              detail: failure.reason,
            }),
        ),
      )
      const transition = reduceSandboxShell(state, key, scenarios)
      state = transition.state

      if (transition.command._tag === 'exit') {
        return {
          startedScenarios,
          ...(state.lastRun ? {lastRun: state.lastRun} : {}),
        }
      }
      if (transition.command._tag === 'start-run') {
        const scenarioId = transition.command.scenarioId
        const scenario = scenarios.find((candidate) => candidate.id === scenarioId)
        if (!scenario) {
          return yield* Effect.fail(
            new SandboxShellFailure({
              operation: 'run-scenario',
              reason: 'scenario-failed',
              scenarioId,
            }),
          )
        }
        startedScenarios.push(scenario.id)
        const summary = yield* runner.run(scenario)
        state = {...state, panel: 'result', lastRun: summary}
      }

      yield* paint(state)
    }
  })
}
