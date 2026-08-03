import {Chalk} from 'chalk'
import {
  renderConfigFormFrame,
  renderPlainConfigForm,
  type ConfigFormView,
} from './config-form-view.js'
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
  prefersReducedMotion,
  supportsInteractiveTui,
  type TerminalEnvironment,
  type TerminalOutput,
} from './terminal-dashboard.js'

export interface ConfigFormConsoleOptions {
  readonly output?: TerminalOutput
  readonly enabled?: boolean
  readonly env?: TerminalEnvironment
}

/**
 * The interactive surface a live migration configuration owns. It is deliberately static: the form
 * only repaints when the operator changes something, so no timer can advance the interface on the
 * operator's behalf.
 */
export class ConfigFormConsole {
  private readonly output: TerminalOutput
  private readonly enabled: boolean
  private readonly reducedMotion: boolean
  private view: ConfigFormView | undefined
  private mounted = false
  private lastFrame = ''
  private lastPlain = ''

  public constructor(options: ConfigFormConsoleOptions = {}) {
    const environment = options.env ?? process.env
    this.output = options.output ?? process.stdout
    this.enabled = (options.enabled ?? true) && supportsInteractiveTui(this.output, environment)
    this.reducedMotion = prefersReducedMotion(environment)
  }

  public get isEnabled(): boolean {
    return this.enabled
  }

  public open(): void {
    if (this.mounted) {
      return
    }
    this.mounted = true
    this.lastFrame = ''
    this.lastPlain = ''
    if (!this.enabled) {
      return
    }
    this.output.write(
      `${SYNCHRONIZED_UPDATE_BEGIN}${ALTERNATE_SCREEN_ENTER}${CURSOR_HIDE}${SCREEN_CLEAR}${SCREEN_HOME}${SYNCHRONIZED_UPDATE_END}`,
    )
    this.output.on?.('resize', this.handleResize)
    process.once('exit', this.restoreTerminal)
  }

  public close(): void {
    if (!this.mounted) {
      return
    }
    this.mounted = false
    if (!this.enabled) {
      return
    }
    try {
      this.output.off?.('resize', this.handleResize)
    } catch {
      // A misbehaving output must not prevent process-listener detachment.
    }
    process.off('exit', this.restoreTerminal)
    this.restoreTerminal()
  }

  public show(view: ConfigFormView): void {
    this.view = view
    this.paint()
  }

  private paint(): void {
    if (!this.mounted || !this.view) {
      return
    }
    if (!this.enabled) {
      const plain = renderPlainConfigForm(this.view).join('\n')
      if (plain === this.lastPlain) {
        return
      }
      this.lastPlain = plain
      this.output.write(`${plain}\n`)
      return
    }
    const frame = renderConfigFormFrame(
      this.view,
      {
        columns: this.output.columns ?? 100,
        rows: this.output.rows ?? 24,
        reducedMotion: this.reducedMotion,
        color: true,
      },
      new Chalk({level: 1}),
    ).join('\n')
    if (frame === this.lastFrame) {
      return
    }
    this.lastFrame = frame
    this.output.write(
      `${SYNCHRONIZED_UPDATE_BEGIN}${SCREEN_HOME}${frame}${SCREEN_RESET_STYLE}${SCREEN_CLEAR_TO_END}${SYNCHRONIZED_UPDATE_END}`,
    )
  }

  private readonly handleResize = (): void => {
    this.lastFrame = ''
    this.paint()
  }

  private readonly restoreTerminal = (): void => {
    this.output.write(
      `${SYNCHRONIZED_UPDATE_BEGIN}${SCREEN_RESET_STYLE}${CURSOR_SHOW}${ALTERNATE_SCREEN_LEAVE}${SYNCHRONIZED_UPDATE_END}`,
    )
  }
}
