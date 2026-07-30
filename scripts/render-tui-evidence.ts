import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {
  renderMigrationDashboardFrame,
  type MigrationDashboardState,
} from '../src/ui/terminal-dashboard.js'

interface EvidenceScenario {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly state: MigrationDashboardState
  readonly columns: number
  readonly rows: number
  readonly frameIndex: number
  readonly reducedMotion?: boolean
}

const baseState: MigrationDashboardState = {
  runId: 'run-enterprise-platform-042',
  source: 'https://dev.azure.com/contoso/Platform Engineering',
  target: 'contoso-enterprise',
  apply: false,
  phase: 'fetch',
  status: 'running',
  message: 'Reading source teams and membership boundaries.',
}

const scenarios: readonly EvidenceScenario[] = [
  {
    id: 'wide-live',
    title: 'Wide · live discovery',
    description: 'Full hierarchy for advanced terminal users at 120 columns.',
    state: baseState,
    columns: 120,
    rows: 30,
    frameIndex: 2,
  },
  {
    id: 'standard-live',
    title: 'Standard · identity matching',
    description: 'Responsive operating view for a common 80-column terminal.',
    state: {
      ...baseState,
      phase: 'map',
      message: 'Matching source identities to managed GitHub users.',
    },
    columns: 80,
    rows: 20,
    frameIndex: 5,
  },
  {
    id: 'narrow-live',
    title: 'Narrow · resize edge',
    description: 'Minimum-density frame after a narrow resize.',
    state: {
      ...baseState,
      phase: 'dry-run',
      message: 'Building the exact migration plan and audit report.',
    },
    columns: 36,
    rows: 8,
    frameIndex: 7,
  },
  {
    id: 'blocked',
    title: 'Blocked · operator decision',
    description: 'Explicit non-color status and recovery direction.',
    state: {
      ...baseState,
      apply: true,
      phase: 'create-teams',
      status: 'blocked',
      message: 'One operator decision is required before work can continue.',
    },
    columns: 120,
    rows: 30,
    frameIndex: 0,
  },
  {
    id: 'failed',
    title: 'Failure · safe recovery',
    description: 'Failure state remains stable and points to recovery output.',
    state: {
      ...baseState,
      apply: true,
      phase: 'assign-members',
      status: 'failed',
      message: 'Migration stopped; recovery guidance follows.',
    },
    columns: 80,
    rows: 20,
    frameIndex: 0,
  },
  {
    id: 'complete',
    title: 'Complete · durable receipt',
    description: 'Every stage closes and the report becomes the next action.',
    state: {
      ...baseState,
      phase: 'report',
      status: 'completed',
      message: 'Migration report and durable receipt are ready.',
    },
    columns: 120,
    rows: 30,
    frameIndex: 0,
  },
  {
    id: 'reduced-motion',
    title: 'Reduced motion · accessible',
    description: 'Static progress marker with identical text hierarchy.',
    state: {
      ...baseState,
      phase: 'grant-repositories',
      message: 'Applying approved repository permissions.',
    },
    columns: 80,
    rows: 20,
    frameIndex: 8,
    reducedMotion: true,
  },
]

const animationScenarios: readonly EvidenceScenario[] = Array.from(
  {length: 10},
  (_, frameIndex) => ({
    id: `animation-${frameIndex}`,
    title: 'Live progress animation',
    description: 'Consecutive atomic frames from the production renderer.',
    state: {
      ...baseState,
      phase: 'map',
      message: 'Matching source identities to managed GitHub users.',
    },
    columns: 100,
    rows: 24,
    frameIndex,
  }),
)

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function ansiToHtml(value: string): string {
  const state = {bold: false, dim: false, color: ''}
  let result = ''
  let cursor = 0
  let spanOpen = false
  // eslint-disable-next-line no-control-regex -- parses ANSI SGR escape sequences to reproduce colored frames as HTML
  const pattern = /\u001b\[([0-9;]*)m/g
  for (const match of value.matchAll(pattern)) {
    result += escapeHtml(value.slice(cursor, match.index))
    if (spanOpen) {
      result += '</span>'
      spanOpen = false
    }
    const codes = (match[1] || '0').split(';').map(Number)
    for (const code of codes) {
      if (code === 0) {
        state.bold = false
        state.dim = false
        state.color = ''
      } else if (code === 1) {
        state.bold = true
      } else if (code === 2) {
        state.dim = true
      } else if (code === 22) {
        state.bold = false
        state.dim = false
      } else if (code === 31) {
        state.color = 'red'
      } else if (code === 32) {
        state.color = 'green'
      } else if (code === 33) {
        state.color = 'yellow'
      } else if (code === 36) {
        state.color = 'cyan'
      } else if (code === 39) {
        state.color = ''
      }
    }
    const classes = [state.bold && 'bold', state.dim && 'dim', state.color]
      .filter(Boolean)
      .join(' ')
    if (classes) {
      result += `<span class="${classes}">`
      spanOpen = true
    }
    cursor = (match.index ?? 0) + match[0].length
  }
  result += escapeHtml(value.slice(cursor))
  if (spanOpen) {
    result += '</span>'
  }
  return result
}

function renderScenario(scenario: EvidenceScenario): string {
  const frame = renderMigrationDashboardFrame(scenario.state, {
    columns: scenario.columns,
    rows: scenario.rows,
    frameIndex: scenario.frameIndex,
    elapsedMs: 42_000,
    color: true,
    ...(scenario.reducedMotion === undefined ? {} : {reducedMotion: scenario.reducedMotion}),
  }).join('\n')
  return `<article class="evidence-card" id="${scenario.id}">
  <header>
    <div><h2>${escapeHtml(scenario.title)}</h2><p>${escapeHtml(scenario.description)}</p></div>
    <span>${scenario.columns} × ${scenario.rows}</span>
  </header>
  <pre>${ansiToHtml(frame)}</pre>
</article>`
}

function renderCapturePage(scenario: EvidenceScenario): string {
  const frame = renderMigrationDashboardFrame(scenario.state, {
    columns: scenario.columns,
    rows: scenario.rows,
    frameIndex: scenario.frameIndex,
    elapsedMs: 42_000,
    color: true,
    ...(scenario.reducedMotion === undefined ? {} : {reducedMotion: scenario.reducedMotion}),
  }).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; --bg:#05080d; --text:#e6edf3; --muted:#8290a3; --cyan:#39c5cf; --green:#56d364; --yellow:#e3b341; --red:#ff7b72; }
  html,body { margin:0; padding:0; background:var(--bg); }
  pre { display:inline-block; margin:0; padding:4px; background:var(--bg); color:var(--text); font:12px/1.4 "Cascadia Mono","Cascadia Code","SFMono-Regular",Consolas,"Liberation Mono",monospace; letter-spacing:0; white-space:pre; }
  .bold { font-weight:600; } .dim { color:var(--muted); } .cyan { color:var(--cyan); } .green { color:var(--green); } .yellow { color:var(--yellow); } .red { color:var(--red); }
</style></head>
<body><pre>${ansiToHtml(frame)}</pre></body></html>`
}

function renderDocument(selectedScenario?: EvidenceScenario): string {
  const renderedScenarios = selectedScenario ? [selectedScenario] : scenarios
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ADO to GitHub Teams · TUI visual evidence</title>
<style>
  :root { color-scheme: dark; --bg:#070b12; --panel:#0d1420; --line:#263244; --text:#e6edf3; --muted:#8290a3; --cyan:#39c5cf; --green:#56d364; --yellow:#e3b341; --red:#ff7b72; }
  * { box-sizing: border-box; }
  body { margin:0; background:radial-gradient(circle at top right,#132134 0,#070b12 42%); color:var(--text); font-family:Inter,Segoe UI,sans-serif; }
  main { width:min(1520px,calc(100% - 48px)); margin:0 auto; padding:48px 0 72px; }
  .hero { display:flex; justify-content:space-between; gap:24px; align-items:end; margin-bottom:32px; }
  h1 { margin:0 0 8px; font-size:32px; letter-spacing:-.03em; }
  .hero p,.evidence-card p { margin:0; color:var(--muted); line-height:1.5; }
  .badge { border:1px solid #24545c; color:var(--cyan); background:#0d2428; border-radius:999px; padding:8px 12px; font:600 12px ui-monospace,Consolas,monospace; }
  .grid { display:grid; gap:24px; }
  .evidence-card { overflow:hidden; border:1px solid var(--line); border-radius:14px; background:color-mix(in srgb,var(--panel) 94%,transparent); box-shadow:0 18px 60px #0007; }
  .evidence-card header { display:flex; justify-content:space-between; gap:24px; align-items:center; padding:18px 20px; border-bottom:1px solid var(--line); }
  h2 { margin:0 0 4px; font-size:16px; }
  .evidence-card header > span { color:var(--muted); font:12px ui-monospace,Consolas,monospace; white-space:nowrap; }
  pre { margin:0; overflow:auto; padding:24px; background:#05080d; color:var(--text); font:14px/1.25 "Cascadia Mono","SFMono-Regular",Consolas,monospace; tab-size:2; }
  .bold { font-weight:700; } .dim { color:var(--muted); } .cyan { color:var(--cyan); } .green { color:var(--green); } .yellow { color:var(--yellow); } .red { color:var(--red); }
  @media (max-width:760px) { main { width:min(100% - 24px,1520px); padding-top:28px; } .hero { align-items:start; flex-direction:column; } pre { padding:16px; font-size:12px; } }
</style>
</head>
<body>
<main>
  <section class="hero">
    <div><h1>Modern TUI visual evidence</h1><p>Deterministic frames from the production renderer across live, resize, safety, failure, completion, and accessibility states.</p></div>
    <div class="badge">ATOMIC REDRAW · 12 FPS MAX · RESPONSIVE</div>
  </section>
  <section class="grid">${renderedScenarios.map(renderScenario).join('')}</section>
</main>
</body>
</html>`
}

const outputDirectory = path.resolve(process.argv[2] ?? 'test/bdd/features/evidence/tui')
await mkdir(outputDirectory, {recursive: true})
const outputPath = path.join(outputDirectory, 'index.html')
await Promise.all([
  writeFile(outputPath, renderDocument(), 'utf8'),
  ...scenarios.map((scenario) =>
    writeFile(
      path.join(outputDirectory, `${scenario.id}.html`),
      renderCapturePage(scenario),
      'utf8',
    ),
  ),
  ...animationScenarios.map((scenario) =>
    writeFile(
      path.join(outputDirectory, `${scenario.id}.html`),
      renderCapturePage(scenario),
      'utf8',
    ),
  ),
])
console.log(outputPath)
