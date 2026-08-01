import {Chalk, type ChalkInstance} from 'chalk'
import type {MigrationProgressEvent, MigrationProgressStatus} from './migration-progress.js'
import {
  ALTERNATE_SCREEN_ENTER,
  ALTERNATE_SCREEN_LEAVE,
  CURSOR_HIDE,
  CURSOR_SHOW,
  SCREEN_CLEAR,
  SCREEN_CLEAR_TO_END,
  SCREEN_HOME,
  SCREEN_RESET_STYLE,
  SYNCHRONIZED_UPDATE_BEGIN,
  SYNCHRONIZED_UPDATE_END,
  fitToWidth,
  formatElapsedLabel,
  panelBorder,
  panelContentLine,
  prefersReducedMotion,
  renderMigrationDashboardFrame,
  renderPlainMigrationProgress,
  sanitizeText,
  spinnerFrame,
  statusTone,
  supportsInteractiveTui,
  truncateToWidth,
  visibleWidth,
  type DashboardFrameOptions,
  type DashboardSurface,
  type MigrationDashboardState,
  type TerminalDashboardSuspension,
  type TerminalEnvironment,
  type TerminalOutput,
} from './terminal-dashboard.js'

export const SANDBOX_CONSOLE_CONTROLS = '↑↓ select • Enter start • g guide • q exit • Ctrl+C exit'

export interface SandboxConsoleScenario {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly mode: 'dry-run' | 'apply'
  readonly scope: string
  readonly expectation: string
}

export interface SandboxConsoleRunSummary {
  readonly scenarioId: string
  readonly status: MigrationProgressStatus
  readonly headline: string
  readonly detail: string
  readonly lines?: readonly string[]
}

export type SandboxConsoleView =
  | {
      readonly _tag: 'browse'
      readonly scenarios: readonly SandboxConsoleScenario[]
      readonly selectedIndex: number
      readonly lastRun?: SandboxConsoleRunSummary
    }
  | {
      readonly _tag: 'guide'
      readonly lines: readonly string[]
    }
  | {
      readonly _tag: 'result'
      readonly summary: SandboxConsoleRunSummary
    }
  | {
      readonly _tag: 'run'
      readonly scenarioId: string
      readonly state: MigrationDashboardState
    }

function selectedScenario(
  scenarios: readonly SandboxConsoleScenario[],
  selectedIndex: number,
): SandboxConsoleScenario | undefined {
  return scenarios[Math.min(Math.max(0, selectedIndex), Math.max(0, scenarios.length - 1))]
}

function browseStatus(view: Extract<SandboxConsoleView, {_tag: 'browse'}>): {
  readonly status: MigrationProgressStatus
  readonly label: string
} {
  if (!view.lastRun) {
    return {status: 'queued', label: 'READY'}
  }
  return view.lastRun.status === 'failed'
    ? {status: 'failed', label: 'LAST RUN FAILED'}
    : {status: 'completed', label: 'LAST RUN COMPLETE'}
}

function scenarioRows(
  view: Extract<SandboxConsoleView, {_tag: 'browse'}>,
  innerWidth: number,
  budget: number,
  chalk: ChalkInstance,
): readonly string[] {
  const total = view.scenarios.length
  const visible = Math.max(1, Math.min(total, budget))
  const start = Math.max(0, Math.min(view.selectedIndex - Math.floor(visible / 2), total - visible))
  return view.scenarios.slice(start, start + visible).map((scenario, offset) => {
    const index = start + offset
    const isSelected = index === view.selectedIndex
    const marker = isSelected ? '❯' : ' '
    const mode = scenario.mode === 'apply' ? 'apply' : 'dry-run'
    const titleBudget = Math.max(1, innerWidth - visibleWidth(mode) - 6)
    const title = truncateToWidth(scenario.title, titleBudget)
    const gap = Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(mode) - 4)
    const row = ` ${marker} ${title}${' '.repeat(gap)}${mode} `
    return panelContentLine(isSelected ? chalk.cyan(row) : chalk.dim(row), innerWidth)
  })
}

function renderBrowse(
  view: Extract<SandboxConsoleView, {_tag: 'browse'}>,
  options: Required<DashboardFrameOptions>,
  chalk: ChalkInstance,
): readonly string[] {
  const innerWidth = Math.max(1, options.columns - 2)
  const scenario = selectedScenario(view.scenarios, view.selectedIndex)
  const status = browseStatus(view)
  const brand = ' ADO → GITHUB TEAMS'
  const mode = 'SANDBOX • NO PROVIDER WRITES'
  const modeLabel = truncateToWidth(mode, Math.max(8, innerWidth - visibleWidth(brand) - 2))
  const headerSpace = Math.max(1, innerWidth - visibleWidth(brand) - visibleWidth(modeLabel) - 1)
  const marker = spinnerFrame(options.frameIndex, options.reducedMotion)
  const listBudget = Math.max(1, options.rows - 13)
  const lines = [
    panelBorder(chalk, '╭', options.columns, '╮'),
    panelContentLine(
      `${chalk.bold(brand)}${' '.repeat(headerSpace)}${statusTone(chalk, 'blocked', modeLabel)}`,
      innerWidth,
    ),
    panelContentLine(
      ` ${chalk.dim('SANDBOX CONTROL PLANE')}  ${statusTone(chalk, status.status, `● ${status.label}`)}  ${chalk.dim(`open ${formatElapsedLabel(options.elapsedMs)}`)}`,
      innerWidth,
    ),
    panelBorder(chalk, '├', options.columns, '┤'),
    panelContentLine(
      ` ${chalk.dim(`SCENARIOS ${String(view.selectedIndex + 1).padStart(2, '0')}/${String(view.scenarios.length).padStart(2, '0')}`)}  ${chalk.dim('nothing runs until you press Enter')}`,
      innerWidth,
    ),
    ...scenarioRows(view, innerWidth, listBudget, chalk),
    panelBorder(chalk, '├', options.columns, '┤'),
    panelContentLine(
      ` ${chalk.dim('ABOUT')}  ${truncateToWidth(scenario?.description ?? 'No scenarios are configured.', Math.max(1, innerWidth - 9))}`,
      innerWidth,
    ),
    panelContentLine(
      ` ${chalk.dim('SCOPE')}  ${truncateToWidth(scenario?.scope ?? '—', Math.max(1, innerWidth - 9))}`,
      innerWidth,
    ),
    panelContentLine(
      ` ${chalk.dim('FIXTURE')} ${truncateToWidth(scenario?.expectation ?? '—', Math.max(1, innerWidth - 10))}`,
      innerWidth,
    ),
    panelContentLine(
      ` ${chalk.dim('NEXT')}   ${truncateToWidth(
        scenario
          ? `Press Enter to start ${scenario.id} as a ${scenario.mode} run with real approval prompts.`
          : 'Press q to exit this sandbox session.',
        Math.max(1, innerWidth - 9),
      )}`,
      innerWidth,
    ),
    panelContentLine(
      ` ${chalk.dim('LAST')}   ${truncateToWidth(
        view.lastRun
          ? `${view.lastRun.headline} — ${view.lastRun.detail}`
          : 'No scenario has been started in this session.',
        Math.max(1, innerWidth - 9),
      )}`,
      innerWidth,
    ),
    panelBorder(chalk, '├', options.columns, '┤'),
    panelContentLine(
      ` ${statusTone(chalk, status.status, marker)} ${chalk.dim(truncateToWidth(SANDBOX_CONSOLE_CONTROLS, Math.max(1, innerWidth - 4)))}`,
      innerWidth,
    ),
    panelBorder(chalk, '╰', options.columns, '╯'),
  ]
  return lines.slice(0, options.rows)
}

function renderGuide(
  view: Extract<SandboxConsoleView, {_tag: 'guide'}>,
  options: Required<DashboardFrameOptions>,
  chalk: ChalkInstance,
): readonly string[] {
  const innerWidth = Math.max(1, options.columns - 2)
  const bodyBudget = Math.max(1, options.rows - 5)
  return [
    panelBorder(chalk, '╭', options.columns, '╮'),
    panelContentLine(` ${chalk.bold('SANDBOX SCENARIO CONTRACTS')}`, innerWidth),
    panelBorder(chalk, '├', options.columns, '┤'),
    ...view.lines
      .slice(0, bodyBudget)
      .map((line) =>
        panelContentLine(
          ` ${chalk.dim(truncateToWidth(line, Math.max(1, innerWidth - 2)))}`,
          innerWidth,
        ),
      ),
    panelBorder(chalk, '├', options.columns, '┤'),
    panelContentLine(
      ` ${chalk.dim(truncateToWidth('Enter or g returns to the scenario list • q exits', Math.max(1, innerWidth - 2)))}`,
      innerWidth,
    ),
    panelBorder(chalk, '╰', options.columns, '╯'),
  ].slice(0, options.rows)
}

function renderResult(
  view: Extract<SandboxConsoleView, {_tag: 'result'}>,
  options: Required<DashboardFrameOptions>,
  chalk: ChalkInstance,
): readonly string[] {
  const innerWidth = Math.max(1, options.columns - 2)
  const bodyBudget = Math.max(1, options.rows - 7)
  const tone = view.summary.status === 'failed' ? 'failed' : 'completed'
  const lines = view.summary.lines ?? [`${view.summary.headline} — ${view.summary.detail}`]
  return [
    panelBorder(chalk, '╭', options.columns, '╮'),
    panelContentLine(
      ` ${chalk.bold('SANDBOX RUN RESULT')}  ${statusTone(chalk, tone, `● ${view.summary.scenarioId}`)}`,
      innerWidth,
    ),
    panelBorder(chalk, '├', options.columns, '┤'),
    panelContentLine(
      ` ${statusTone(chalk, tone, truncateToWidth(view.summary.headline, Math.max(1, innerWidth - 2)))}`,
      innerWidth,
    ),
    ...lines
      .slice(-bodyBudget)
      .map((line) =>
        panelContentLine(
          ` ${chalk.dim(truncateToWidth(sanitizeText(line), Math.max(1, innerWidth - 2)))}`,
          innerWidth,
        ),
      ),
    panelBorder(chalk, '├', options.columns, '┤'),
    panelContentLine(
      ` ${chalk.dim(truncateToWidth('Any key returns to the scenario list • q exits the sandbox session', Math.max(1, innerWidth - 2)))}`,
      innerWidth,
    ),
    panelBorder(chalk, '╰', options.columns, '╯'),
  ].slice(0, options.rows)
}

function renderRun(
  view: Extract<SandboxConsoleView, {_tag: 'run'}>,
  options: Required<DashboardFrameOptions>,
  chalk: ChalkInstance,
): readonly string[] {
  const footer = fitToWidth(
    chalk.dim(
      truncateToWidth(
        `Sandbox shell stays open • ${view.scenarioId} returns to the scenario list when it finishes`,
        options.columns,
      ),
    ),
    options.columns,
  )
  const frame = renderMigrationDashboardFrame(view.state, {
    ...options,
    rows: Math.max(1, options.rows - 1),
  })
  return [...frame, footer].slice(0, options.rows)
}

export function renderSandboxConsoleFrame(
  view: SandboxConsoleView,
  options: DashboardFrameOptions,
): readonly string[] {
  const normalized: Required<DashboardFrameOptions> = {
    columns: Math.max(1, Math.floor(options.columns)),
    rows: Math.max(1, Math.floor(options.rows)),
    frameIndex: options.frameIndex ?? 0,
    elapsedMs: options.elapsedMs ?? 0,
    color: options.color ?? false,
    reducedMotion: options.reducedMotion ?? false,
  }
  const chalk = new Chalk({level: normalized.color ? 1 : 0})
  switch (view._tag) {
    case 'run':
      return renderRun(view, normalized, chalk)
    case 'guide':
      return renderGuide(view, normalized, chalk)
    case 'result':
      return renderResult(view, normalized, chalk)
    case 'browse':
      return renderBrowse(view, normalized, chalk)
  }
}

export function renderPlainSandboxConsole(view: SandboxConsoleView): readonly string[] {
  switch (view._tag) {
    case 'run':
      return [renderPlainMigrationProgress(view.state)]
    case 'guide':
      return view.lines.map((line) => sanitizeText(line))
    case 'result':
      return [
        sanitizeText(`Sandbox run result — ${view.summary.headline}`),
        ...(view.summary.lines ?? [view.summary.detail]).map((line) => sanitizeText(line)),
        'Any key returns to the scenario list; q exits the sandbox session.',
      ]
    case 'browse':
      return [
        'Sandbox scenarios — nothing runs until you press Enter.',
        ...view.scenarios.map((scenario, index) =>
          sanitizeText(
            `${index === view.selectedIndex ? '>' : ' '} ${scenario.id.padEnd(24)} ${scenario.mode.padEnd(7)} ${scenario.title}`,
          ),
        ),
        view.lastRun
          ? sanitizeText(`Last run: ${view.lastRun.headline} — ${view.lastRun.detail}`)
          : 'Last run: none in this session.',
        SANDBOX_CONSOLE_CONTROLS,
      ]
  }
}

export interface SandboxConsoleOptions {
  readonly output?: TerminalOutput
  readonly enabled?: boolean
  readonly reducedMotion?: boolean
  readonly clock?: () => number
  readonly frameIntervalMs?: number
  readonly env?: TerminalEnvironment
}

/**
 * The single terminal surface an interactive sandbox session owns. It stays mounted for the whole
 * session, renders the scenario browser and the production migration dashboard through the same
 * surface, and only relinquishes the terminal while an approval prompt is open.
 */
export class SandboxConsole implements DashboardSurface {
  private readonly output: TerminalOutput
  private readonly enabled: boolean
  private readonly reducedMotion: boolean
  private readonly clock: () => number
  private readonly frameIntervalMs: number
  private readonly startedAt: number
  private view: SandboxConsoleView
  private runState: MigrationDashboardState | undefined
  private runScenarioId = ''
  private browseView: Extract<SandboxConsoleView, {_tag: 'browse'}>
  private frameIndex = 0
  private mounted = false
  private interval: ReturnType<typeof setInterval> | undefined
  private resizeTimer: ReturnType<typeof setTimeout> | undefined
  private lastFrame = ''
  private lastPlain = ''

  public constructor(view: SandboxConsoleView, options: SandboxConsoleOptions = {}) {
    const environment = options.env ?? process.env
    this.output = options.output ?? process.stdout
    this.enabled = (options.enabled ?? true) && supportsInteractiveTui(this.output, environment)
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion(environment)
    this.clock = options.clock ?? Date.now
    this.frameIntervalMs = Math.max(50, options.frameIntervalMs ?? 80)
    this.startedAt = this.clock()
    this.view = view
    this.browseView =
      view._tag === 'browse' ? view : {_tag: 'browse', scenarios: [], selectedIndex: 0}
  }

  public get isEnabled(): boolean {
    return this.enabled
  }

  public get currentView(): SandboxConsoleView {
    return this.view
  }

  public open(): void {
    if (this.mounted) {
      return
    }
    this.mounted = true
    this.lastFrame = ''
    this.lastPlain = ''
    if (!this.enabled) {
      this.renderPlain()
      return
    }
    try {
      this.output.write(
        `${SYNCHRONIZED_UPDATE_BEGIN}${ALTERNATE_SCREEN_ENTER}${CURSOR_HIDE}${SCREEN_CLEAR}${SCREEN_HOME}${SYNCHRONIZED_UPDATE_END}`,
      )
      this.output.on?.('resize', this.handleResize)
      process.once('exit', this.restoreTerminal)
      process.once('SIGINT', this.handleSigint)
      process.once('SIGTERM', this.handleSigterm)
      this.render()
      this.interval = setInterval(() => {
        this.frameIndex += 1
        this.render()
      }, this.frameIntervalMs)
      this.interval.unref?.()
    } catch (error) {
      this.detachLifecycle()
      this.mounted = false
      throw error
    }
  }

  public close(): void {
    if (!this.mounted) {
      return
    }
    this.mounted = false
    if (!this.enabled) {
      return
    }
    this.detachLifecycle()
    this.restoreTerminal()
  }

  public show(view: SandboxConsoleView): void {
    if (view._tag === 'browse') {
      this.browseView = view
    }
    this.view = view
    this.paint()
  }

  /** Binds the console to a migration run so the presentation renders inside this same surface. */
  public runSurface(scenarioId: string, state: MigrationDashboardState): DashboardSurface {
    this.runScenarioId = scenarioId
    this.runState = state
    return this
  }

  public start(): void {
    if (!this.runState) {
      return
    }
    this.view = {_tag: 'run', scenarioId: this.runScenarioId, state: this.runState}
    this.paint()
  }

  public stop(): void {
    this.runState = undefined
    this.view = this.browseView
    this.paint()
  }

  public update(update: Partial<MigrationDashboardState> | MigrationProgressEvent): void {
    if (!this.runState) {
      return
    }
    this.runState = {...this.runState, ...update}
    if (this.view._tag === 'run') {
      this.view = {_tag: 'run', scenarioId: this.runScenarioId, state: this.runState}
      this.paint()
    }
  }

  public suspend(): TerminalDashboardSuspension {
    const suspension = {wasActive: this.enabled && this.mounted}
    if (suspension.wasActive) {
      this.detachLifecycle()
      this.restoreTerminal()
      this.mounted = false
    }
    return suspension
  }

  public resume(suspension: TerminalDashboardSuspension): void {
    if (suspension.wasActive) {
      this.open()
    }
  }

  private paint(): void {
    if (!this.mounted) {
      return
    }
    if (this.enabled) {
      this.render()
      return
    }
    this.renderPlain()
  }

  private detachLifecycle(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = undefined
    }
    process.off('exit', this.restoreTerminal)
    process.off('SIGINT', this.handleSigint)
    process.off('SIGTERM', this.handleSigterm)
    try {
      this.output.off?.('resize', this.handleResize)
    } catch {
      // A misbehaving output must not prevent process-listener detachment.
    }
  }

  private readonly handleResize = (): void => {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer)
    }
    this.resizeTimer = setTimeout(() => {
      this.lastFrame = ''
      this.render()
    }, 16)
  }

  private readonly restoreTerminal = (): void => {
    this.output.write(
      `${SYNCHRONIZED_UPDATE_BEGIN}${SCREEN_RESET_STYLE}${CURSOR_SHOW}${ALTERNATE_SCREEN_LEAVE}${SYNCHRONIZED_UPDATE_END}`,
    )
  }

  private readonly handleSigint = (): void => {
    this.handleSignal('SIGINT')
  }

  private readonly handleSigterm = (): void => {
    this.handleSignal('SIGTERM')
  }

  private handleSignal(signal: NodeJS.Signals): void {
    this.close()
    process.kill(process.pid, signal)
  }

  private renderPlain(): void {
    const lines = renderPlainSandboxConsole(this.view).join('\n')
    if (lines === this.lastPlain) {
      return
    }
    this.lastPlain = lines
    this.output.write(`${lines}\n`)
  }

  private render(): void {
    const frame = renderSandboxConsoleFrame(this.view, {
      columns: this.output.columns ?? 100,
      rows: this.output.rows ?? 24,
      frameIndex: this.frameIndex,
      elapsedMs: this.clock() - this.startedAt,
      color: true,
      reducedMotion: this.reducedMotion,
    }).join('\n')
    if (frame === this.lastFrame) {
      return
    }
    this.lastFrame = frame
    this.output.write(
      `${SYNCHRONIZED_UPDATE_BEGIN}${SCREEN_HOME}${frame}${SCREEN_RESET_STYLE}${SCREEN_CLEAR_TO_END}${SYNCHRONIZED_UPDATE_END}`,
    )
  }
}
