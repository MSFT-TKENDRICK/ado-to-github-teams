import {Chalk, type ChalkInstance} from 'chalk'
import {MIGRATION_STAGES, migrationStageStatus} from './migration-stage-status.js'
import type {MigrationProgressEvent, MigrationProgressStatus} from './migration-progress.js'

// eslint-disable-next-line no-control-regex -- strips ANSI escape sequences (ESC-prefixed) from untrusted provider text
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex -- neutralizes C0 control chars and DEL so provider text cannot inject terminal sequences
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/g
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h'
const LEAVE_ALTERNATE_SCREEN = '\u001b[?1049l'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const BEGIN_SYNCHRONIZED_UPDATE = '\u001b[?2026h'
const END_SYNCHRONIZED_UPDATE = '\u001b[?2026l'
const HOME = '\u001b[H'
const CLEAR_SCREEN = '\u001b[2J'
const CLEAR_TO_END = '\u001b[J'
const RESET_STYLE = '\u001b[0m'

export interface MigrationDashboardState {
  readonly runId: string
  readonly source: string
  readonly target: string
  readonly apply: boolean
  readonly phase: string
  readonly status: MigrationProgressStatus
  readonly message: string
  readonly updatedAt?: string
  readonly completedUnits?: number
  readonly totalUnits?: number
  readonly unitLabel?: string
}

export interface DashboardFrameOptions {
  readonly columns: number
  readonly rows: number
  readonly frameIndex?: number
  readonly elapsedMs?: number
  readonly color?: boolean
  readonly reducedMotion?: boolean
}

export interface TerminalOutput {
  readonly isTTY?: boolean
  readonly columns?: number
  readonly rows?: number
  write(chunk: string): unknown
  on?(event: 'resize', listener: () => void): unknown
  off?(event: 'resize', listener: () => void): unknown
}

export interface TerminalDashboardOptions {
  readonly output?: TerminalOutput
  readonly enabled?: boolean
  readonly reducedMotion?: boolean
  readonly clock?: () => number
  readonly frameIntervalMs?: number
  readonly env?: TerminalEnvironment
}

export interface TerminalEnvironment {
  readonly [name: string]: string | undefined
  readonly CI?: string
  readonly NO_TUI?: string
  readonly REDUCE_MOTION?: string
  readonly SCREEN_READER?: string
  readonly TERM?: string
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {granularity: 'grapheme'})
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u
const COMBINING_MARK = /\p{Mark}/u

function graphemes(value: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), ({segment}) => segment)
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}

function graphemeWidth(grapheme: string): number {
  if (
    EMOJI_GRAPHEME.test(grapheme) ||
    [...grapheme].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff
    })
  ) {
    return 2
  }
  return [...grapheme].reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint === 0 ||
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      COMBINING_MARK.test(character)
    ) {
      return width
    }
    return width + (isWideCodePoint(codePoint) ? 2 : 1)
  }, 0)
}

export function visibleWidth(value: string): number {
  return graphemes(stripAnsi(value)).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0)
}

function sanitize(value: string): string {
  return value.replace(ANSI_PATTERN, '').replaceAll(CONTROL_PATTERN, ' ').replaceAll(/\s+/g, ' ')
}

function truncate(value: string, width: number): string {
  const safe = sanitize(value)
  if (width <= 0) {
    return ''
  }
  if (visibleWidth(safe) <= width) {
    return safe
  }
  if (width === 1) {
    return '…'
  }
  const targetWidth = width - 1
  let usedWidth = 0
  const prefix: string[] = []
  for (const grapheme of graphemes(safe)) {
    const nextWidth = graphemeWidth(grapheme)
    if (usedWidth + nextWidth > targetWidth) {
      break
    }
    prefix.push(grapheme)
    usedWidth += nextWidth
  }
  return `${prefix.join('')}…`
}

function fit(value: string, width: number): string {
  const plain = stripAnsi(value)
  const currentWidth = visibleWidth(plain)
  if (currentWidth > width) {
    return truncate(plain, width)
  }
  return `${value}${' '.repeat(Math.max(0, width - currentWidth))}`
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function phaseIndex(phase: string): number {
  const index = MIGRATION_STAGES.findIndex((stage) => stage.phase === phase)
  return index >= 0 ? index : 0
}

function statusLabel(status: MigrationProgressStatus): string {
  switch (status) {
    case 'completed':
      return 'COMPLETE'
    case 'blocked':
      return 'NEEDS INPUT'
    case 'failed':
      return 'FAILED'
    case 'queued':
      return 'QUEUED'
    case 'running':
      return 'LIVE'
  }
}

function unitProgress(state: MigrationDashboardState): number | undefined {
  if (
    state.completedUnits === undefined ||
    state.totalUnits === undefined ||
    !Number.isFinite(state.completedUnits) ||
    !Number.isFinite(state.totalUnits) ||
    state.totalUnits <= 0
  ) {
    return undefined
  }
  return Math.min(1, Math.max(0, state.completedUnits / state.totalUnits))
}

function progressLabel(state: MigrationDashboardState): string {
  const progress = unitProgress(state)
  if (progress !== undefined) {
    return `${Math.max(0, state.completedUnits ?? 0)}/${Math.max(0, state.totalUnits ?? 0)} ${sanitize(state.unitLabel ?? 'units')}`
  }
  const stage = `${String(phaseIndex(state.phase) + 1).padStart(2, '0')}/${String(MIGRATION_STAGES.length).padStart(2, '0')}`
  return state.status === 'running' ? `${stage} • INDETERMINATE` : `STAGE ${stage}`
}

function progressCue(state: MigrationDashboardState): string {
  const progress = unitProgress(state)
  if (progress !== undefined) {
    return `${Math.max(0, state.completedUnits ?? 0)}/${Math.max(0, state.totalUnits ?? 0)}`
  }
  if (state.status === 'completed') {
    return 'DONE'
  }
  if (state.status === 'running') {
    return '~LIVE'
  }
  return `${String(phaseIndex(state.phase) + 1).padStart(2, '0')}/${String(MIGRATION_STAGES.length).padStart(2, '0')}`
}

function progressBar(
  state: MigrationDashboardState,
  width: number,
  frameIndex: number,
  reducedMotion: boolean,
): string {
  const innerWidth = Math.max(4, width - 2)
  const determinateProgress = unitProgress(state)
  const filled =
    state.status === 'completed'
      ? innerWidth
      : determinateProgress === undefined
        ? Math.floor((phaseIndex(state.phase) / MIGRATION_STAGES.length) * innerWidth)
        : Math.round(innerWidth * determinateProgress)
  const pulseWidth = Math.max(3, Math.floor(innerWidth / 6))
  const pulseStart = reducedMotion
    ? Math.max(0, filled)
    : (frameIndex % (innerWidth + pulseWidth)) - pulseWidth
  const cells = Array.from({length: innerWidth}, (_, index) => {
    if (determinateProgress !== undefined || state.status !== 'running') {
      return index < filled ? '█' : '░'
    }
    return index >= pulseStart && index < pulseStart + pulseWidth ? '▓' : '░'
  }).join('')
  return `[${cells}]`
}

function tone(chalk: ChalkInstance, status: MigrationProgressStatus, value: string): string {
  switch (status) {
    case 'completed':
      return chalk.green(value)
    case 'blocked':
      return chalk.yellow(value)
    case 'failed':
      return chalk.red(value)
    case 'queued':
      return chalk.dim(value)
    case 'running':
      return chalk.cyan(value)
  }
}

function stageMarker(
  state: MigrationDashboardState,
  index: number,
  frameIndex: number,
  reducedMotion: boolean,
): {readonly marker: string; readonly label: string; readonly status: MigrationProgressStatus} {
  const current = phaseIndex(state.phase)
  if (state.status === 'completed' || index < current) {
    return {marker: '✓', label: 'complete', status: 'completed'}
  }
  if (index > current) {
    return {marker: '○', label: 'queued', status: 'queued'}
  }
  if (state.status === 'blocked') {
    return {marker: '!', label: 'needs input', status: 'blocked'}
  }
  if (state.status === 'failed') {
    return {marker: '×', label: 'failed', status: 'failed'}
  }
  const marker = reducedMotion ? '◆' : SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]!
  return {marker, label: state.status === 'queued' ? 'queued' : 'in progress', status: state.status}
}

function border(chalk: ChalkInstance, left: string, width: number, right: string): string {
  return chalk.dim(`${left}${'─'.repeat(Math.max(0, width - 2))}${right}`)
}

function contentLine(value: string, innerWidth: number): string {
  return `│${fit(value, innerWidth)}│`
}

function renderUltraCompact(
  state: MigrationDashboardState,
  options: Required<DashboardFrameOptions>,
  chalk: ChalkInstance,
): readonly string[] {
  const width = options.columns
  const stage = migrationStageStatus({
    runId: state.runId,
    phase: state.phase,
    workflowStatus: state.status,
  })
  const spinner =
    state.status === 'running'
      ? options.reducedMotion
        ? '◆'
        : SPINNER_FRAMES[options.frameIndex % SPINNER_FRAMES.length]!
      : state.status === 'completed'
        ? '✓'
        : state.status === 'failed'
          ? '×'
          : state.status === 'blocked'
            ? '!'
            : '○'
  const mode = state.apply ? 'APPLY' : 'DRY RUN'
  const modeTone: MigrationProgressStatus = state.apply ? 'blocked' : 'completed'
  const brand = 'ADO → GITHUB TEAMS'
  const shortBrand = 'ADO→GH'
  const header =
    width >= visibleWidth(brand) + visibleWidth(mode) + 1
      ? `${chalk.bold(brand)}${' '.repeat(Math.max(1, width - visibleWidth(brand) - visibleWidth(mode)))}${tone(chalk, modeTone, mode)}`
      : width >= visibleWidth(mode) + 1 + visibleWidth(shortBrand)
        ? `${tone(chalk, modeTone, mode)}${' '.repeat(Math.max(1, width - visibleWidth(mode) - visibleWidth(shortBrand)))}${chalk.dim(shortBrand)}`
        : tone(chalk, modeTone, mode)
  const cue = progressCue(state)
  const barWidth = Math.max(6, width - visibleWidth(cue) - 1)
  return [
    fit(header, width),
    fit(
      `${tone(chalk, state.status, `${spinner} ${statusLabel(state.status)}`)}  ${truncate(stage.currentStage, Math.max(1, width - 14))}`,
      width,
    ),
    fit(
      `${chalk.dim(cue)} ${tone(chalk, state.status, progressBar(state, barWidth, options.frameIndex, options.reducedMotion))}`,
      width,
    ),
    fit(truncate(state.message, width), width),
    fit(chalk.dim(`Run ${truncate(state.runId, Math.max(1, width - 4))}`), width),
    fit(chalk.dim(`Elapsed ${formatElapsed(options.elapsedMs)} • Ctrl+C to stop`), width),
  ].slice(0, options.rows)
}

function renderCompact(
  state: MigrationDashboardState,
  options: Required<DashboardFrameOptions>,
  chalk: ChalkInstance,
): readonly string[] {
  const innerWidth = options.columns - 2
  const stage = migrationStageStatus({
    runId: state.runId,
    phase: state.phase,
    workflowStatus: state.status,
  })
  const marker = stageMarker(
    state,
    phaseIndex(state.phase),
    options.frameIndex,
    options.reducedMotion,
  )
  const mode = state.apply ? 'APPLY • TARGET WRITES ENABLED' : 'DRY RUN • NO TARGET WRITES'
  const brand = ' ADO → GITHUB TEAMS'
  const modeLabel = truncate(mode, Math.max(8, innerWidth - visibleWidth(brand) - 2))
  const headerSpace = Math.max(1, innerWidth - visibleWidth(brand) - visibleWidth(modeLabel) - 1)
  const lines = [
    border(chalk, '╭', options.columns, '╮'),
    contentLine(
      `${chalk.bold(brand)}${' '.repeat(headerSpace)}${chalk.bold(modeLabel)}`,
      innerWidth,
    ),
    border(chalk, '├', options.columns, '┤'),
    contentLine(
      ` ${tone(chalk, marker.status, `${marker.marker} ${statusLabel(state.status)}`)}  ${chalk.bold(truncate(stage.currentStage, Math.max(1, innerWidth - 18)))}`,
      innerWidth,
    ),
    contentLine(
      (() => {
        const elapsed = formatElapsed(options.elapsedMs)
        const label = progressLabel(state)
        const barWidth = Math.max(8, innerWidth - visibleWidth(label) - visibleWidth(elapsed) - 4)
        const labelBudget = Math.max(1, innerWidth - barWidth - visibleWidth(elapsed) - 4)
        return ` ${tone(chalk, state.status, progressBar(state, barWidth, options.frameIndex, options.reducedMotion))} ${chalk.dim(truncate(label, labelBudget))} ${chalk.dim(elapsed)}`
      })(),
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('NOW')}   ${truncate(state.message, Math.max(1, innerWidth - 8))}`,
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('NEXT')}  ${truncate(stage.nextEvent, Math.max(1, innerWidth - 8))}`,
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('SCOPE')} ${truncate(`${state.source} → ${state.target}`, Math.max(1, innerWidth - 8))}`,
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('RUN')}   ${truncate(state.runId, Math.max(1, innerWidth - 8))}`,
      innerWidth,
    ),
    border(chalk, '├', options.columns, '┤'),
    contentLine(
      ` ${tone(chalk, state.status, '●')} ${statusLabel(state.status)} ${chalk.dim('• Ctrl+C stop • --no-tui plain output')}`,
      innerWidth,
    ),
    border(chalk, '╰', options.columns, '╯'),
  ]
  return lines.slice(0, options.rows)
}

function renderWide(
  state: MigrationDashboardState,
  options: Required<DashboardFrameOptions>,
  chalk: ChalkInstance,
): readonly string[] {
  const innerWidth = options.columns - 2
  const stage = migrationStageStatus({
    runId: state.runId,
    phase: state.phase,
    workflowStatus: state.status,
  })
  const mode = state.apply ? 'APPLY • TARGET WRITES ENABLED' : 'DRY RUN • NO TARGET WRITES'
  const brand = ' ADO → GITHUB TEAMS'
  const modeLabel = truncate(mode, Math.max(8, innerWidth - visibleWidth(brand) - 2))
  const headerSpace = Math.max(1, innerWidth - visibleWidth(brand) - visibleWidth(modeLabel) - 1)
  const stageLabelWidth = Math.min(38, Math.max(24, innerWidth - 29))
  const lines = [
    border(chalk, '╭', options.columns, '╮'),
    contentLine(
      `${chalk.bold(brand)}${' '.repeat(headerSpace)}${tone(chalk, state.apply ? 'blocked' : 'completed', modeLabel)}`,
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('MIGRATION CONTROL PLANE')}  ${tone(chalk, state.status, `● ${statusLabel(state.status)}`)}  ${chalk.dim(`elapsed ${formatElapsed(options.elapsedMs)}`)}`,
      innerWidth,
    ),
    border(chalk, '├', options.columns, '┤'),
    ...MIGRATION_STAGES.map((definition, index) => {
      const marker = stageMarker(state, index, options.frameIndex, options.reducedMotion)
      return contentLine(
        ` ${tone(chalk, marker.status, marker.marker)} ${fit(definition.label, stageLabelWidth)} ${fit(marker.label, 12)}`,
        innerWidth,
      )
    }),
    border(chalk, '├', options.columns, '┤'),
    contentLine(
      ` ${chalk.dim('NOW')}     ${truncate(state.message, Math.max(1, innerWidth - 10))}`,
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('NEXT')}    ${truncate(stage.nextEvent, Math.max(1, innerWidth - 10))}`,
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('SCOPE')}   ${truncate(state.source, Math.max(1, Math.floor((innerWidth - 15) / 2)))} → ${truncate(state.target, Math.max(1, Math.ceil((innerWidth - 15) / 2)))}`,
      innerWidth,
    ),
    contentLine(
      ` ${chalk.dim('RUN')}     ${truncate(state.runId, Math.max(1, innerWidth - 10))}`,
      innerWidth,
    ),
    contentLine(
      ` ${tone(chalk, state.status, progressBar(state, Math.max(8, innerWidth - 27), options.frameIndex, options.reducedMotion))} ${fit(progressLabel(state), 24)}`,
      innerWidth,
    ),
    border(chalk, '├', options.columns, '┤'),
    contentLine(
      ` ${tone(chalk, state.status, '●')} Status ${statusLabel(state.status)}  ${chalk.dim('• Ctrl+C stop safely • --no-tui plain output • resize supported')}`,
      innerWidth,
    ),
    border(chalk, '╰', options.columns, '╯'),
  ]
  return lines.slice(0, options.rows)
}

export function renderMigrationDashboardFrame(
  state: MigrationDashboardState,
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
  if (normalized.rows < 12 || normalized.columns < 40) {
    return renderUltraCompact(state, normalized, chalk)
  }
  if (normalized.columns < 88 || normalized.rows < 20) {
    return renderCompact(state, normalized, chalk)
  }
  return renderWide(state, normalized, chalk)
}

export function supportsInteractiveTui(
  output: Pick<TerminalOutput, 'isTTY'>,
  environment: TerminalEnvironment = process.env,
): boolean {
  return Boolean(
    output.isTTY &&
    environment.TERM !== 'dumb' &&
    environment.NO_TUI !== '1' &&
    environment.SCREEN_READER !== '1' &&
    !environment.CI,
  )
}

export function prefersReducedMotion(environment: TerminalEnvironment = process.env): boolean {
  return environment.REDUCE_MOTION === '1' || environment.SCREEN_READER === '1'
}

export function renderPlainMigrationProgress(state: MigrationDashboardState): string {
  const stage = migrationStageStatus({
    runId: state.runId,
    phase: state.phase,
    workflowStatus: state.status,
  })
  return `[${statusLabel(state.status)}] ${sanitize(state.runId)} · ${sanitize(stage.currentStage)} · ${progressLabel(state)} · ${sanitize(state.message)} · Next: ${sanitize(stage.nextEvent)}`
}

export class TerminalDashboard {
  private readonly output: TerminalOutput
  private readonly enabled: boolean
  private readonly reducedMotion: boolean
  private readonly clock: () => number
  private readonly frameIntervalMs: number
  private readonly startedAt: number
  private state: MigrationDashboardState
  private frameIndex = 0
  private active = false
  private interval: ReturnType<typeof setInterval> | undefined
  private resizeTimer: ReturnType<typeof setTimeout> | undefined
  private lastFrame = ''
  private lastPlainProgress = ''
  private plainStarted = false

  public constructor(state: MigrationDashboardState, options: TerminalDashboardOptions = {}) {
    const environment = options.env ?? process.env
    this.output = options.output ?? process.stdout
    this.enabled = (options.enabled ?? true) && supportsInteractiveTui(this.output, environment)
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion(environment)
    this.clock = options.clock ?? Date.now
    this.frameIntervalMs = Math.max(50, options.frameIntervalMs ?? 80)
    this.startedAt = this.clock()
    this.state = state
  }

  public get isEnabled(): boolean {
    return this.enabled
  }

  public start(): void {
    if (!this.enabled) {
      if (!this.plainStarted) {
        this.plainStarted = true
        this.lastPlainProgress = ''
        this.renderPlainProgress()
      }
      return
    }
    if (this.active) {
      return
    }
    this.active = true
    this.lastFrame = ''
    try {
      this.output.write(
        `${BEGIN_SYNCHRONIZED_UPDATE}${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${CLEAR_SCREEN}${HOME}${END_SYNCHRONIZED_UPDATE}`,
      )
      this.output.on?.('resize', this.handleResize)
      process.once('exit', this.restoreTerminal)
      process.once('SIGINT', this.handleSigint)
      process.once('SIGTERM', this.handleSigterm)
      this.render()
      if (!this.reducedMotion && this.state.status === 'running') {
        this.interval = setInterval(() => {
          this.frameIndex += 1
          this.render()
        }, this.frameIntervalMs)
        this.interval.unref?.()
      }
    } catch (error) {
      this.abortStartup()
      throw error
    }
  }

  public update(update: Partial<MigrationDashboardState> | MigrationProgressEvent): void {
    this.state = {...this.state, ...update}
    if (this.active) {
      this.render()
    } else if (this.plainStarted) {
      this.renderPlainProgress()
    }
  }

  public stop(): void {
    if (!this.enabled) {
      this.plainStarted = false
      return
    }
    if (!this.active) {
      return
    }
    this.detachLifecycle()
    this.active = false
    this.restoreTerminal()
  }

  private abortStartup(): void {
    this.detachLifecycle()
    try {
      this.restoreTerminal()
    } catch {
      // Best-effort alternate-screen restoration; start() rethrows the original startup failure.
    }
    this.active = false
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
      `${BEGIN_SYNCHRONIZED_UPDATE}${RESET_STYLE}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}${END_SYNCHRONIZED_UPDATE}`,
    )
  }

  private readonly handleSigint = (): void => {
    this.handleSignal('SIGINT')
  }

  private readonly handleSigterm = (): void => {
    this.handleSignal('SIGTERM')
  }

  private handleSignal(signal: NodeJS.Signals): void {
    this.stop()
    process.kill(process.pid, signal)
  }

  private renderPlainProgress(): void {
    const line = renderPlainMigrationProgress(this.state)
    if (line === this.lastPlainProgress) {
      return
    }
    this.lastPlainProgress = line
    this.output.write(`${line}\n`)
  }

  private render(): void {
    const frame = renderMigrationDashboardFrame(this.state, {
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
      `${BEGIN_SYNCHRONIZED_UPDATE}${HOME}${frame}${RESET_STYLE}${CLEAR_TO_END}${END_SYNCHRONIZED_UPDATE}`,
    )
  }
}
