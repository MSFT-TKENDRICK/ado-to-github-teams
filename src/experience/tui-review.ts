import {
  renderPlainMigrationProgress,
  renderMigrationDashboardFrame,
  supportsInteractiveTui,
  visibleWidth,
  type MigrationDashboardState,
} from '../ui/terminal-dashboard.js'

export interface TuiReviewPersona {
  readonly id: string
  readonly name: string
  readonly perspective: string
  readonly evidenceExpected: readonly string[]
}

export interface TuiReviewFeedback {
  readonly personaId: string
  readonly scenario: string
  readonly feedback: string
}

export const TUI_REVIEW_PERSONAS: readonly TuiReviewPersona[] = [
  {
    id: 'advanced-agentic-tui-operator',
    name: 'Avery',
    perspective:
      'Daily Claude Code CLI and Grok Build user who expects dense live state, stable redraw, and command-ready controls.',
    evidenceExpected: [
      'live stage',
      'elapsed time',
      'next event',
      'keyboard escape',
      'plain fallback',
    ],
  },
  {
    id: 'enterprise-tui-designer',
    name: 'Priya',
    perspective:
      'Enterprise product designer reviewing hierarchy, responsive density, motion restraint, and corporate visual tone.',
    evidenceExpected: [
      'brand hierarchy',
      'status hierarchy',
      'responsive layout',
      'bounded motion',
    ],
  },
  {
    id: 'nonvisual-terminal-operator',
    name: 'Jordan',
    perspective:
      'Screen-reader operator who requires line-oriented fallback and status meaning that never depends on color.',
    evidenceExpected: [
      'text status',
      'reduced motion',
      'non-TTY fallback',
      'no color-only meaning',
    ],
  },
  {
    id: 'terminal-rendering-reliability-reviewer',
    name: 'Morgan',
    perspective:
      'Adversarial terminal reliability reviewer focused on atomic frames, resize bounds, and untrusted text.',
    evidenceExpected: [
      'stable frame shape',
      'no overflow',
      'control-code sanitization',
      'resize redraw',
    ],
  },
]

const RUNNING_STATE: MigrationDashboardState = {
  runId: 'run-enterprise-platform-042',
  source: 'https://dev.azure.com/contoso/Platform Engineering',
  target: 'contoso-enterprise',
  apply: false,
  phase: 'map',
  status: 'running',
  message: 'Matching source identities to managed GitHub users.',
  updatedAt: '2026-07-30T16:00:00.000Z',
}

function reviewFrameBounds(feedback: TuiReviewFeedback[], columns: number, rows: number): void {
  const frames = [0, 1].map((frameIndex) =>
    renderMigrationDashboardFrame(RUNNING_STATE, {
      columns,
      rows,
      frameIndex,
      elapsedMs: 12_000,
      reducedMotion: false,
    }),
  )
  for (const [frameIndex, frame] of frames.entries()) {
    if (frame.length > rows) {
      feedback.push({
        personaId: 'terminal-rendering-reliability-reviewer',
        scenario: `${columns}x${rows} frame ${frameIndex}`,
        feedback: `Frame uses ${frame.length} rows in a ${rows}-row terminal.`,
      })
    }
    const overflow = frame.find((line) => visibleWidth(line) > columns)
    if (overflow) {
      feedback.push({
        personaId: 'terminal-rendering-reliability-reviewer',
        scenario: `${columns}x${rows} frame ${frameIndex}`,
        feedback: `Frame exceeds the ${columns}-column viewport.`,
      })
    }
  }
  if (frames[0]?.length !== frames[1]?.length) {
    feedback.push({
      personaId: 'terminal-rendering-reliability-reviewer',
      scenario: `${columns}x${rows} animation`,
      feedback: 'Animation changes frame height and can cause vertical jitter.',
    })
  }
}

export function reviewTuiExperience(): readonly TuiReviewFeedback[] {
  const feedback: TuiReviewFeedback[] = []
  const wide = renderMigrationDashboardFrame(RUNNING_STATE, {
    columns: 120,
    rows: 30,
    frameIndex: 2,
    elapsedMs: 12_000,
  }).join('\n')
  for (const expected of [
    'ADO → GITHUB TEAMS',
    'LIVE',
    'NOW',
    'NEXT',
    'SCOPE',
    'RUN',
    'Ctrl+C',
    '--no-tui',
    'INDETERMINATE',
  ]) {
    if (!wide.includes(expected)) {
      feedback.push({
        personaId: 'advanced-agentic-tui-operator',
        scenario: 'wide live migration',
        feedback: `Live dashboard is missing "${expected}".`,
      })
    }
  }

  const reducedMotion = renderMigrationDashboardFrame(RUNNING_STATE, {
    columns: 72,
    rows: 18,
    frameIndex: 8,
    elapsedMs: 12_000,
    reducedMotion: true,
  }).join('\n')
  if (!reducedMotion.includes('◆') || !reducedMotion.includes('LIVE')) {
    feedback.push({
      personaId: 'nonvisual-terminal-operator',
      scenario: 'reduced motion',
      feedback: 'Reduced-motion mode must retain a static marker and explicit text status.',
    })
  }
  if (supportsInteractiveTui({isTTY: true}, {TERM: 'xterm-256color', SCREEN_READER: '1'})) {
    feedback.push({
      personaId: 'nonvisual-terminal-operator',
      scenario: 'screen-reader fallback',
      feedback: 'Screen-reader mode must use stable line-oriented output instead of live redraw.',
    })
  }

  for (const [columns, rows] of [
    [12, 6],
    [36, 8],
    [72, 18],
    [120, 30],
    [160, 40],
  ] as const) {
    reviewFrameBounds(feedback, columns, rows)
  }

  const hostile = renderMigrationDashboardFrame(
    {
      ...RUNNING_STATE,
      source: '組織\ncontoso\u001b[2J forged',
      message: 'Safe update\u0007 with\tuntrusted provider text.',
    },
    {columns: 72, rows: 18},
  )
  // eslint-disable-next-line no-control-regex -- asserts hostile provider text cannot leak ESC/BEL/newline/tab into a frame
  if (hostile.some((line) => /[\u001b\u0007\n\t]/.test(line))) {
    feedback.push({
      personaId: 'terminal-rendering-reliability-reviewer',
      scenario: 'untrusted terminal text',
      feedback: 'External text can inject terminal control sequences.',
    })
  }
  const unicodeFrame = renderMigrationDashboardFrame(
    {...RUNNING_STATE, source: '組織/Platform 👩🏽‍💻'},
    {columns: 40, rows: 18},
  )
  if (unicodeFrame.some((line) => visibleWidth(line) > 40)) {
    feedback.push({
      personaId: 'terminal-rendering-reliability-reviewer',
      scenario: 'Unicode cell width',
      feedback: 'Wide or emoji graphemes overflow the terminal viewport.',
    })
  }
  const plain = renderPlainMigrationProgress(RUNNING_STATE)
  if (!plain.includes('[LIVE]') || !plain.includes('INDETERMINATE') || plain.includes('\u001b')) {
    feedback.push({
      personaId: 'nonvisual-terminal-operator',
      scenario: 'plain live progress',
      feedback: 'Plain fallback does not provide meaningful ANSI-free live status.',
    })
  }

  const compact = renderMigrationDashboardFrame(RUNNING_STATE, {
    columns: 72,
    rows: 18,
  }).join('\n')
  if (compact === wide || !compact.includes('DRY RUN')) {
    feedback.push({
      personaId: 'enterprise-tui-designer',
      scenario: 'responsive hierarchy',
      feedback: 'Compact layout must preserve safety hierarchy while reducing density.',
    })
  }
  const narrow = renderMigrationDashboardFrame(RUNNING_STATE, {
    columns: 36,
    rows: 8,
  }).join('\n')
  if (!narrow.includes('DRY RUN')) {
    feedback.push({
      personaId: 'enterprise-tui-designer',
      scenario: 'minimum-width safety',
      feedback: 'Narrow layout drops the migration safety mode.',
    })
  }

  const compactThroughput = renderMigrationDashboardFrame(RUNNING_STATE, {
    columns: 80,
    rows: 20,
  }).join('\n')
  if (!compactThroughput.includes('INDETERMINATE')) {
    feedback.push({
      personaId: 'advanced-agentic-tui-operator',
      scenario: '80-column indeterminate throughput',
      feedback:
        'Compact progress must label indeterminate work so the bar is not misread as a percentage.',
    })
  }
  const determinateThroughput = renderMigrationDashboardFrame(
    {...RUNNING_STATE, completedUnits: 4, totalUnits: 10, unitLabel: 'members'},
    {columns: 80, rows: 20},
  ).join('\n')
  if (!determinateThroughput.includes('4/10')) {
    feedback.push({
      personaId: 'advanced-agentic-tui-operator',
      scenario: '80-column determinate throughput',
      feedback: 'Compact progress must show completed/total counts when unit totals are known.',
    })
  }
  for (const apply of [false, true] as const) {
    const tiny = renderMigrationDashboardFrame(
      {...RUNNING_STATE, apply},
      {columns: 12, rows: 6},
    ).join('\n')
    if (!tiny.includes(apply ? 'APPLY' : 'DRY RUN')) {
      feedback.push({
        personaId: 'enterprise-tui-designer',
        scenario: `12-column ${apply ? 'apply' : 'dry-run'} safety`,
        feedback: 'Ultra-compact layout must keep the safety mode visible ahead of branding.',
      })
    }
  }

  for (const status of ['blocked', 'failed', 'completed'] as const) {
    const terminal = renderMigrationDashboardFrame(
      {...RUNNING_STATE, status},
      {columns: 120, rows: 30},
    ).join('\n')
    if (
      terminal.includes('Live status') ||
      !terminal.includes(`Status ${statusLabelForReview(status)}`)
    ) {
      feedback.push({
        personaId: 'enterprise-tui-designer',
        scenario: `${status} terminal state`,
        feedback: 'Terminal-state footer does not match the actual workflow status.',
      })
    }
  }

  return feedback
}

function statusLabelForReview(status: 'blocked' | 'failed' | 'completed'): string {
  return status === 'blocked' ? 'NEEDS INPUT' : status === 'failed' ? 'FAILED' : 'COMPLETE'
}
