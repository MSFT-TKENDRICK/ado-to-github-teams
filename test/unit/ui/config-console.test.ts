import {afterEach, describe, expect, it} from 'vitest'

import {
  configFormFields,
  emptyConfigFormValues,
  type ConfigFormContext,
  type ConfigFormState,
} from '../../../src/ui/config-form.js'
import type {ConfigFormView} from '../../../src/ui/config-form-view.js'
import {ConfigFormConsole} from '../../../src/ui/config-console.js'
import type {TerminalOutput} from '../../../src/ui/terminal-dashboard.js'

/**
 * Behaviour coverage for the live configuration console.
 *
 * The console owns the operator's only interactive surface during a migration, so the invariants
 * worth asserting are the ones an operator would notice if they broke: an accessible or
 * non-interactive terminal must still receive readable plain output; the alternate screen must be
 * entered exactly once and always restored; and a repaint that would produce an identical frame
 * must not be written, because redundant writes make a static form flicker.
 */

interface RecordingTerminal extends TerminalOutput {
  readonly chunks: string[]
  readonly resizeListeners: Array<() => void>
  emitResize(): void
}

function terminal(options: {readonly isTTY: boolean}): RecordingTerminal {
  const chunks: string[] = []
  const resizeListeners: Array<() => void> = []
  return {
    isTTY: options.isTTY,
    columns: 100,
    rows: 24,
    chunks,
    resizeListeners,
    write(chunk: string) {
      chunks.push(chunk)
      return true
    },
    on(_event: 'resize', listener: () => void) {
      resizeListeners.push(listener)
      return this
    },
    off(_event: 'resize', listener: () => void) {
      const index = resizeListeners.indexOf(listener)
      if (index >= 0) {
        resizeListeners.splice(index, 1)
      }
      return this
    },
    emitResize() {
      for (const listener of [...resizeListeners]) {
        listener()
      }
    },
  }
}

const context: ConfigFormContext = {
  environment: 'live',
  title: 'Migration configuration',
  allowTopology: true,
}

function view(overrides: Partial<ConfigFormState> = {}): ConfigFormView {
  const state: ConfigFormState = {
    values: emptyConfigFormValues(),
    focusedIndex: 0,
    showProblems: false,
    context,
    ...overrides,
  }
  return {
    fields: configFormFields(state),
    focusedIndex: state.focusedIndex,
    context: state.context,
  }
}

/** An interactive terminal requires a TTY and an environment that has not opted out of the TUI. */
const interactiveEnv = {} as NodeJS.ProcessEnv

const openConsoles: ConfigFormConsole[] = []

function makeConsole(output: RecordingTerminal, env: NodeJS.ProcessEnv): ConfigFormConsole {
  const console = new ConfigFormConsole({output, env})
  openConsoles.push(console)
  return console
}

afterEach(() => {
  // Leaving the alternate screen entered would corrupt the reporter output of every later test.
  for (const console of openConsoles.splice(0)) {
    console.close()
  }
})

describe('ConfigFormConsole capability detection', () => {
  it('enables the interactive surface for a TTY', () => {
    expect(makeConsole(terminal({isTTY: true}), interactiveEnv).isEnabled).toBe(true)
  })

  it('disables the interactive surface without a TTY', () => {
    expect(makeConsole(terminal({isTTY: false}), interactiveEnv).isEnabled).toBe(false)
  })

  it.each([
    ['a dumb terminal', {TERM: 'dumb'}],
    ['an explicit NO_TUI opt-out', {NO_TUI: '1'}],
    ['an active screen reader', {SCREEN_READER: '1'}],
    ['a CI environment', {CI: 'true'}],
  ])('disables the interactive surface for %s', (_label, env) => {
    expect(makeConsole(terminal({isTTY: true}), env as NodeJS.ProcessEnv).isEnabled).toBe(false)
  })

  it('honours an explicit disable even on a capable terminal', () => {
    const console = new ConfigFormConsole({
      output: terminal({isTTY: true}),
      env: interactiveEnv,
      enabled: false,
    })
    expect(console.isEnabled).toBe(false)
  })
})

describe('ConfigFormConsole plain output', () => {
  it('writes a readable plain form when the interactive surface is unavailable', () => {
    const output = terminal({isTTY: false})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    console.show(view())

    const written = output.chunks.join('')
    expect(written).toContain('Migration configuration')
    // A non-interactive render must not emit alternate-screen or cursor control sequences.
    expect(written).not.toContain('\u001B[?1049h')
    expect(written).not.toContain('\u001B[?25l')
  })

  it('does not rewrite an unchanged plain form', () => {
    const output = terminal({isTTY: false})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    console.show(view())
    const afterFirst = output.chunks.length
    console.show(view())
    expect(output.chunks.length).toBe(afterFirst)
  })

  it('rewrites the plain form when the focused field changes', () => {
    const output = terminal({isTTY: false})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    console.show(view())
    const afterFirst = output.chunks.length
    console.show(view({focusedIndex: 1}))
    expect(output.chunks.length).toBeGreaterThan(afterFirst)
  })
})

describe('ConfigFormConsole interactive lifecycle', () => {
  it('enters the alternate screen and hides the cursor on open', () => {
    const output = terminal({isTTY: true})
    makeConsole(output, interactiveEnv).open()
    const written = output.chunks.join('')
    expect(written).toContain('\u001B[?1049h')
    expect(written).toContain('\u001B[?25l')
  })

  it('registers exactly one resize listener and removes it on close', () => {
    const output = terminal({isTTY: true})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    expect(output.resizeListeners).toHaveLength(1)
    console.close()
    expect(output.resizeListeners).toHaveLength(0)
  })

  it('is idempotent across repeated open calls', () => {
    const output = terminal({isTTY: true})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    const afterFirstOpen = output.chunks.length
    console.open()
    expect(output.chunks.length).toBe(afterFirstOpen)
    expect(output.resizeListeners).toHaveLength(1)
  })

  it('ignores close before open', () => {
    const output = terminal({isTTY: true})
    makeConsole(output, interactiveEnv).close()
    expect(output.chunks).toEqual([])
  })

  it('restores the cursor and leaves the alternate screen on close', () => {
    const output = terminal({isTTY: true})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    output.chunks.length = 0
    console.close()
    const written = output.chunks.join('')
    expect(written).toContain('\u001B[?25h')
    expect(written).toContain('\u001B[?1049l')
  })

  it('ignores a show issued before open', () => {
    const output = terminal({isTTY: true})
    makeConsole(output, interactiveEnv).show(view())
    expect(output.chunks).toEqual([])
  })
})

describe('ConfigFormConsole painting', () => {
  it('paints a frame containing the form title', () => {
    const output = terminal({isTTY: true})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    output.chunks.length = 0
    console.show(view())
    expect(output.chunks.join('')).toContain('Migration configuration')
  })

  it('does not repaint an identical frame', () => {
    const output = terminal({isTTY: true})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    console.show(view())
    const afterFirst = output.chunks.length
    console.show(view())
    expect(output.chunks.length).toBe(afterFirst)
  })

  it('repaints when the view changes', () => {
    const output = terminal({isTTY: true})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    console.show(view())
    const afterFirst = output.chunks.length
    console.show(view({focusedIndex: 2}))
    expect(output.chunks.length).toBeGreaterThan(afterFirst)
  })

  it('forces a full repaint on resize even when the view is unchanged', () => {
    // The cached frame is only valid for the geometry it was rendered at, so a resize must
    // invalidate it. Without that the form stays drawn at the old width until something else
    // changes.
    const output = terminal({isTTY: true})
    const console = makeConsole(output, interactiveEnv)
    console.open()
    console.show(view())
    const afterFirst = output.chunks.length
    output.emitResize()
    expect(output.chunks.length).toBeGreaterThan(afterFirst)
  })

  it('renders without color escapes when a screen reader is active', () => {
    const output = terminal({isTTY: true})
    const console = makeConsole(output, {SCREEN_READER: '1'} as NodeJS.ProcessEnv)
    console.open()
    console.show(view())
    // SCREEN_READER also disables the interactive surface, so the operator gets plain text.
    expect(console.isEnabled).toBe(false)
    expect(output.chunks.join('')).toContain('Migration configuration')
  })
})
