import {describe, expect, it, vi} from 'vitest'
import {reviewTuiExperience, TUI_REVIEW_PERSONAS} from '../../../src/experience/tui-review.js'
import {
  renderPlainMigrationProgress,
  renderMigrationDashboardFrame,
  supportsInteractiveTui,
  TerminalDashboard,
  visibleWidth,
  type MigrationDashboardState,
  type TerminalOutput,
} from '../../../src/ui/terminal-dashboard.js'

const state: MigrationDashboardState = {
  runId: 'run-42',
  source: 'contoso/Platform',
  target: 'contoso-enterprise',
  apply: false,
  phase: 'assign-members',
  status: 'running',
  message: 'Applying approved team memberships.',
}

class FakeTerminal implements TerminalOutput {
  public isTTY = true
  public columns = 100
  public rows = 24
  public readonly writes: string[] = []
  private resizeListener: (() => void) | undefined

  public write(chunk: string): void {
    this.writes.push(chunk)
  }

  public on(event: 'resize', listener: () => void): void {
    if (event === 'resize') {
      this.resizeListener = listener
    }
  }

  public off(event: 'resize', listener: () => void): void {
    if (event === 'resize' && this.resizeListener === listener) {
      this.resizeListener = undefined
    }
  }

  public resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.resizeListener?.()
  }
}

describe('terminal dashboard', () => {
  it.each([
    [1, 6],
    [12, 6],
    [36, 8],
    [72, 18],
    [120, 30],
    [160, 40],
  ])('fits every rendered frame within a %ix%i viewport', (columns, rows) => {
    const frame = renderMigrationDashboardFrame(state, {
      columns,
      rows,
      frameIndex: 3,
      elapsedMs: 12_000,
    })

    expect(frame.length).toBeLessThanOrEqual(rows)
    expect(frame.every((line) => visibleWidth(line) <= columns)).toBe(true)
  })

  it('communicates live progress, safety, scope, next action, and escape controls', () => {
    const frame = renderMigrationDashboardFrame(state, {
      columns: 120,
      rows: 30,
      frameIndex: 3,
      elapsedMs: 12_000,
    }).join('\n')

    expect(frame).toContain('ADO → GITHUB TEAMS')
    expect(frame).toContain('DRY RUN • NO TARGET WRITES')
    expect(frame).toContain('LIVE')
    expect(frame).toContain('Assigning team members')
    expect(frame).toContain('NEXT')
    expect(frame).toContain('contoso/Platform → contoso-enterprise')
    expect(frame).toContain('Ctrl+C')
    expect(frame).toContain('--no-tui')
  })

  it('keeps the safety mode visible at minimum width and labels terminal states truthfully', () => {
    const narrow = renderMigrationDashboardFrame(state, {
      columns: 36,
      rows: 8,
    }).join('\n')
    const complete = renderMigrationDashboardFrame(
      {...state, status: 'completed'},
      {columns: 120, rows: 30},
    ).join('\n')

    expect(narrow).toContain('DRY RUN')
    expect(complete).toContain('Status COMPLETE')
    expect(complete).not.toContain('Live status')
  })

  it('labels compact throughput and keeps the safety mode ahead of branding when ultra-compact', () => {
    const compactIndeterminate = renderMigrationDashboardFrame(state, {
      columns: 80,
      rows: 20,
    }).join('\n')
    const compactDeterminate = renderMigrationDashboardFrame(
      {...state, completedUnits: 4, totalUnits: 10, unitLabel: 'members'},
      {columns: 80, rows: 20},
    ).join('\n')
    const tinyDryRun = renderMigrationDashboardFrame(state, {columns: 12, rows: 6}).join('\n')
    const tinyApply = renderMigrationDashboardFrame(
      {...state, apply: true},
      {columns: 12, rows: 6},
    ).join('\n')

    expect(compactIndeterminate).toContain('INDETERMINATE')
    expect(compactDeterminate).toContain('4/10 members')
    expect(tinyDryRun).toContain('DRY RUN')
    expect(tinyApply).toContain('APPLY')
  })

  it('animates without changing frame shape and honors reduced motion', () => {
    const animated = [0, 1].map((frameIndex) =>
      renderMigrationDashboardFrame(state, {
        columns: 120,
        rows: 30,
        frameIndex,
        elapsedMs: 12_000,
      }),
    )
    const reduced = renderMigrationDashboardFrame(state, {
      columns: 72,
      rows: 18,
      frameIndex: 7,
      reducedMotion: true,
    }).join('\n')

    expect(animated[0]).not.toEqual(animated[1])
    expect(animated[0]?.length).toBe(animated[1]?.length)
    expect(reduced).toContain('◆')
    expect(reduced).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })

  it('labels unknown throughput as indeterminate and supports real unit counts', () => {
    const indeterminate = renderMigrationDashboardFrame(state, {
      columns: 120,
      rows: 30,
    }).join('\n')
    const determinate = renderMigrationDashboardFrame(
      {...state, completedUnits: 4, totalUnits: 10, unitLabel: 'members'},
      {columns: 120, rows: 30},
    ).join('\n')

    expect(indeterminate).toContain('INDETERMINATE')
    expect(determinate).toContain('4/10 members')
    expect(renderPlainMigrationProgress(state)).toContain('INDETERMINATE')
  })

  it('measures terminal cells for wide, emoji, and combining graphemes', () => {
    const unicodeState = {
      ...state,
      source: '組織/Platform 👩🏽‍💻',
      target: 'e\u0301nterprise',
      message: '映射 identities',
    }
    const frame = renderMigrationDashboardFrame(unicodeState, {
      columns: 40,
      rows: 18,
    })

    expect(visibleWidth('組織')).toBe(4)
    expect(visibleWidth('👩🏽‍💻')).toBe(2)
    expect(visibleWidth('e\u0301')).toBe(1)
    expect(frame.every((line) => visibleWidth(line) <= 40)).toBe(true)
  })

  it('neutralizes multiline, tab, bell, and ANSI injection in external text', () => {
    const frame = renderMigrationDashboardFrame(
      {
        ...state,
        source: 'org\nINJECTED\tTAB',
        message: 'safe\u0007\u001b[2J message',
      },
      {columns: 72, rows: 18},
    )

    // eslint-disable-next-line no-control-regex -- verifies control-char injection is neutralized in rendered frames
    expect(frame.every((line) => !/[\n\t\u0007\u001b]/.test(line))).toBe(true)
  })

  it('emits deduplicated ANSI-free live progress for non-interactive terminals', () => {
    const output = new FakeTerminal()
    output.isTTY = false
    const dashboard = new TerminalDashboard(state, {output})

    dashboard.start()
    dashboard.update({...state})
    dashboard.update({...state, phase: 'report', message: 'Writing the receipt.'})
    dashboard.stop()

    expect(output.writes).toHaveLength(2)
    expect(output.writes.join('')).toContain('[LIVE] run-42')
    expect(output.writes.join('')).not.toContain('\u001b')
  })

  it('uses synchronized alternate-screen redraw and redraws once after resize settles', () => {
    vi.useFakeTimers()
    const output = new FakeTerminal()
    const dashboard = new TerminalDashboard(state, {
      output,
      clock: () => 12_000,
      frameIntervalMs: 100,
    })
    const initialSigintListeners = process.listenerCount('SIGINT')
    const initialSigtermListeners = process.listenerCount('SIGTERM')

    dashboard.start()
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners + 1)
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners + 1)
    output.resize(72, 18)
    output.resize(70, 16)
    expect(output.writes).toHaveLength(2)
    vi.advanceTimersByTime(16)
    expect(output.writes).toHaveLength(3)
    dashboard.stop()
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners)
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners)

    expect(output.writes[0]).toContain('\u001b[?1049h')
    expect(output.writes[1]).toContain('\u001b[?2026h')
    expect(output.writes[1]).toContain('\u001b[?2026l')
    expect(output.writes.at(-1)).toContain('\u001b[?1049l')
    expect(output.writes.at(-1)).toContain('\u001b[?25h')
    vi.useRealTimers()
  })

  it('falls back for automation, dumb terminals, explicit opt-out, and screen readers', () => {
    expect(supportsInteractiveTui({isTTY: false}, {TERM: 'xterm-256color'})).toBe(false)
    expect(supportsInteractiveTui({isTTY: true}, {CI: '1'})).toBe(false)
    expect(supportsInteractiveTui({isTTY: true}, {TERM: 'dumb'})).toBe(false)
    expect(supportsInteractiveTui({isTTY: true}, {NO_TUI: '1'})).toBe(false)
    expect(supportsInteractiveTui({isTTY: true}, {SCREEN_READER: '1'})).toBe(false)
  })

  it('passes every documented persona and adversarial rendering review', () => {
    expect(TUI_REVIEW_PERSONAS.map(({id}) => id)).toEqual(
      expect.arrayContaining([
        'advanced-agentic-tui-operator',
        'enterprise-tui-designer',
        'nonvisual-terminal-operator',
        'terminal-rendering-reliability-reviewer',
      ]),
    )
    expect(reviewTuiExperience()).toEqual([])
  })
})
