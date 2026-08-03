import {describe, expect, it} from 'vitest'
import {
  renderPlainSandboxConsole,
  renderSandboxConsoleFrame,
  SandboxConsole,
  SANDBOX_CONSOLE_CONTROLS,
  type SandboxConsoleScenario,
} from '../../../src/ui/sandbox-console.js'
import {
  renderMigrationDashboardFrame,
  visibleWidth,
  type MigrationDashboardState,
  type TerminalOutput,
} from '../../../src/ui/terminal-dashboard.js'

const scenarios: readonly SandboxConsoleScenario[] = [
  {
    id: 'happy-path',
    title: 'Happy path dry run',
    description: 'Preview a complete migration plan.',
    mode: 'dry-run',
    scope: 'https://dev.azure.com/contoso/Platform → contoso',
    expectation: 'Predetermined service result: completes successfully.',
  },
  {
    id: 'apply-happy-path',
    title: 'Approved apply',
    description: 'Apply approved memberships.',
    mode: 'apply',
    scope: 'https://dev.azure.com/contoso/Platform → contoso',
    expectation: 'Predetermined service result: completes successfully.',
  },
]

const runState: MigrationDashboardState = {
  runId: 'sandbox-happy-path',
  source: 'contoso/Platform',
  target: 'contoso',
  apply: false,
  sandbox: true,
  phase: 'plan-teams',
  status: 'running',
  message: 'Planning teams from synthetic fixtures.',
}

class FakeTerminal implements TerminalOutput {
  public isTTY = true
  public columns = 100
  public rows = 30
  public writes: string[] = []

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return true
  }

  on(): this {
    return this
  }

  off(): this {
    return this
  }
}

describe('sandbox console frames', () => {
  it('renders a browsable scenario list that never claims a run is starting', () => {
    const frame = renderSandboxConsoleFrame(
      {_tag: 'browse', scenarios, selectedIndex: 1},
      {columns: 100, rows: 30},
    )

    expect(frame.some((line) => line.includes('SANDBOX CONTROL PLANE'))).toBe(true)
    expect(
      frame.some((line) => line.includes('nothing runs until you fill in the configuration')),
    ).toBe(true)
    expect(frame.some((line) => line.includes('SCENARIOS 02/02'))).toBe(true)
    expect(frame.some((line) => line.includes('❯ Approved apply'))).toBe(true)
    expect(frame.some((line) => line.includes('Press Enter to configure apply-happy-path'))).toBe(
      true,
    )
    expect(frame.some((line) => line.includes(SANDBOX_CONSOLE_CONTROLS))).toBe(true)
    expect(frame.every((line) => visibleWidth(line) <= 100)).toBe(true)
    expect(frame.length).toBeLessThanOrEqual(30)
  })

  it('reports the previous run without leaving the browse surface', () => {
    const frame = renderSandboxConsoleFrame(
      {
        _tag: 'browse',
        scenarios,
        selectedIndex: 0,
        lastRun: {
          scenarioId: 'happy-path',
          status: 'completed',
          headline: 'happy-path completed',
          detail: 'report written',
        },
      },
      {columns: 100, rows: 30},
    )

    expect(frame.some((line) => line.includes('LAST RUN COMPLETE'))).toBe(true)
    expect(frame.some((line) => line.includes('happy-path completed — report written'))).toBe(true)
  })

  it('renders a run with the exact production migration dashboard frame', () => {
    const production = renderMigrationDashboardFrame(runState, {columns: 100, rows: 29})
    const frame = renderSandboxConsoleFrame(
      {_tag: 'run', scenarioId: 'happy-path', state: runState},
      {columns: 100, rows: 30},
    )

    expect(frame.slice(0, production.length)).toEqual(production)
    expect(frame.at(-1)).toContain('Sandbox shell stays open')
    expect(frame.every((line) => visibleWidth(line) <= 100)).toBe(true)
    expect(frame.length).toBeLessThanOrEqual(30)
  })

  it('shows the production completion output in a dismissible result view', () => {
    const frame = renderSandboxConsoleFrame(
      {
        _tag: 'result',
        summary: {
          scenarioId: 'happy-path',
          status: 'completed',
          headline: 'happy-path completed',
          detail: 'Report sandbox-happy-path.md',
          lines: [
            'Migration complete.',
            'Record: sandbox-happy-path.md',
            '  a2g --list-sandbox-scenarios',
          ],
        },
      },
      {columns: 100, rows: 30},
    )

    expect(frame.some((line) => line.includes('SANDBOX RUN RESULT'))).toBe(true)
    expect(frame.some((line) => line.includes('Migration complete.'))).toBe(true)
    expect(frame.some((line) => line.includes('Record: sandbox-happy-path.md'))).toBe(true)
    expect(frame.some((line) => line.includes('Any key returns to the scenario list'))).toBe(true)
    expect(frame.every((line) => visibleWidth(line) <= 100)).toBe(true)
    expect(frame.length).toBeLessThanOrEqual(30)
  })

  it('wraps a long report path instead of hiding it behind a truncation', () => {
    const reportPath =
      'C:/src/copilot-worktrees/ado-to-github-teams/msft-tkendrick-musical-garbanzo/sandbox-report-happy-path.md'
    const frame = renderSandboxConsoleFrame(
      {
        _tag: 'result',
        summary: {
          scenarioId: 'happy-path',
          status: 'completed',
          headline: 'happy-path completed',
          detail: `Report ${reportPath}`,
          lines: ['Migration complete.', `Record: ${reportPath}`],
        },
      },
      {columns: 80, rows: 30},
    )

    const body = frame.join('\n')

    expect(body).toContain('Record:')
    expect(body.replaceAll(/[\s│]/gu, '')).toContain(reportPath)
    expect(frame.every((line) => visibleWidth(line) <= 80)).toBe(true)
    expect(frame.filter((line) => line.includes('sandbox-report-happy-path.md')).length).toBe(1)
    expect(frame.some((line) => line.includes('Record:') && line.includes('…'))).toBe(false)
  })

  it('fits narrow viewports without overflowing any view', () => {
    for (const view of [
      {_tag: 'browse' as const, scenarios, selectedIndex: 0},
      {_tag: 'guide' as const, lines: ['Sandbox scenario contracts:', '  happy-path [dry-run]']},
      {_tag: 'run' as const, scenarioId: 'happy-path', state: runState},
    ]) {
      const frame = renderSandboxConsoleFrame(view, {columns: 60, rows: 18})
      expect(frame.every((line) => visibleWidth(line) <= 60)).toBe(true)
      expect(frame.length).toBeLessThanOrEqual(18)
    }
  })

  it('renders a stable line-oriented view when the TUI is unavailable', () => {
    const lines = renderPlainSandboxConsole({_tag: 'browse', scenarios, selectedIndex: 1})

    expect(lines[0]).toBe('Sandbox scenarios — nothing runs until you fill in the configuration.')
    expect(lines[1]?.trimStart().startsWith('happy-path')).toBe(true)
    expect(lines[2]).toContain('> apply-happy-path')
    expect(lines.at(-1)).toBe(SANDBOX_CONSOLE_CONTROLS)
  })
})

describe('SandboxConsole surface', () => {
  it('keeps one alternate screen for the whole session across runs', () => {
    const output = new FakeTerminal()
    const console_ = new SandboxConsole(
      {_tag: 'browse', scenarios, selectedIndex: 0},
      {output, frameIntervalMs: 10_000, reducedMotion: true, env: {}},
    )

    console_.open()
    const enters = output.writes.filter((chunk) => chunk.includes('\u001b[?1049h')).length

    console_.runSurface('happy-path', runState)
    console_.start()
    expect(console_.currentView._tag).toBe('run')
    console_.update({status: 'completed', message: 'done'})
    console_.stop()
    expect(console_.currentView._tag).toBe('browse')

    expect(output.writes.filter((chunk) => chunk.includes('\u001b[?1049h')).length).toBe(enters)
    expect(output.writes.filter((chunk) => chunk.includes('\u001b[?1049l')).length).toBe(0)

    console_.close()
    expect(output.writes.filter((chunk) => chunk.includes('\u001b[?1049l')).length).toBe(1)
  })

  it('keeps the session alternate screen while an approval prompt owns the terminal', () => {
    const output = new FakeTerminal()
    const console_ = new SandboxConsole(
      {_tag: 'browse', scenarios, selectedIndex: 0},
      {output, frameIntervalMs: 10_000, reducedMotion: true, env: {}},
    )

    console_.open()
    const entersAfterOpen = output.writes.filter((chunk) => chunk.includes('\u001b[?1049h')).length
    const suspension = console_.suspend()

    expect(suspension.wasActive).toBe(true)
    expect(output.writes.filter((chunk) => chunk.includes('\u001b[?1049l')).length).toBe(0)
    expect(output.writes.at(-1)).toContain('\u001b[?25h')

    console_.resume(suspension)

    expect(output.writes.filter((chunk) => chunk.includes('\u001b[?1049h')).length).toBe(
      entersAfterOpen,
    )
    expect(output.writes.filter((chunk) => chunk.includes('\u001b[?1049l')).length).toBe(0)

    console_.close()

    expect(output.writes.filter((chunk) => chunk.includes('\u001b[?1049l')).length).toBe(1)
  })

  it('falls back to plain output when the terminal cannot host the surface', () => {
    const output = new FakeTerminal()
    output.isTTY = false
    const console_ = new SandboxConsole(
      {_tag: 'browse', scenarios, selectedIndex: 0},
      {output, env: {}},
    )

    console_.open()

    expect(console_.isEnabled).toBe(false)
    expect(output.writes.join('')).toContain(
      'Sandbox scenarios — nothing runs until you fill in the configuration.',
    )
    expect(output.writes.join('')).not.toContain('\u001b[?1049h')
    console_.close()
  })
})
