import {execFile} from 'node:child_process'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {Effect} from 'effect'
import {loadSandboxCatalog} from '../src/sandbox/config.js'
import {
  runSandboxPresentationTrace,
  type SandboxPresentationTrace,
} from '../src/sandbox/presentation-trace.js'
import {
  renderMigrationDashboardFrame,
  type MigrationDashboardState,
} from '../src/ui/terminal-dashboard.js'

const execFileAsync = promisify(execFile)
const EVIDENCE_SOURCE_PATHS = [
  'src',
  'sandbox/scenarios.yaml',
  'scripts/render-tui-evidence.ts',
  'scripts/capture-tui-evidence.py',
  'test/bdd/features/tui-experience.feature',
  'test/bdd/steps/migration.steps.ts',
] as const

interface EvidenceScenario {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly state: MigrationDashboardState
  readonly columns: number
  readonly rows: number
  readonly frameIndex: number
  readonly reducedMotion?: boolean
  readonly trace: {
    readonly scenarioId: string
    readonly sequence: number
  }
}

interface TuiEvidenceManifest {
  readonly version: 1
  readonly sourceSha: string
  readonly sourcePaths: readonly string[]
  readonly catalogDigest: string
  readonly onboardingCommand: 'npm run dev -- --sandbox happy-path'
  readonly executions: ReadonlyArray<{
    readonly scenarioId: string
    readonly runId: string
    readonly outcome: 'success' | 'failure'
    readonly failureTag?: string
    readonly sequence: ReadonlyArray<{
      readonly sequence: number
      readonly origin: string
      readonly phase: string
      readonly status: string
      readonly message: string
      readonly nextAction?: string
    }>
  }>
  readonly assets: ReadonlyArray<{
    readonly id: string
    readonly scenarioId: string
    readonly sequence: number
    readonly phase: string
    readonly status: string
    readonly columns: number
    readonly rows: number
    readonly reducedMotion: boolean
  }>
}

function executedState(
  trace: SandboxPresentationTrace,
  predicate: (state: MigrationDashboardState, origin: string) => boolean,
  label: string,
): {readonly state: MigrationDashboardState; readonly sequence: number} {
  const snapshot = trace.snapshots.find(({state, origin}) => predicate(state, origin))
  if (!snapshot) {
    throw new Error(`Executed sandbox trace ${trace.scenarioId} did not produce ${label}.`)
  }
  return {state: snapshot.state, sequence: snapshot.sequence}
}

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
    <span>${scenario.columns} × ${scenario.rows} · ${escapeHtml(scenario.trace.scenarioId)}#${scenario.trace.sequence}</span>
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

function renderDocument(scenarios: readonly EvidenceScenario[], sourceSha: string): string {
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
    <div><h1>Modern TUI visual evidence</h1><p>Production-renderer frames derived from executed sandbox orchestration across live, resize, safety, failure, completion, and accessibility states. Source ${escapeHtml(sourceSha.slice(0, 12))}.</p></div>
    <div class="badge">EXECUTED SANDBOX · ATOMIC REDRAW · RESPONSIVE</div>
  </section>
  <section class="grid">${scenarios.map(renderScenario).join('')}</section>
</main>
</body>
</html>`
}

async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.argv[2] ?? 'test/bdd/features/evidence/tui')
  await mkdir(outputDirectory, {recursive: true})
  const traceDirectory = await mkdtemp(path.join(tmpdir(), 'a2g-tui-evidence-'))

  try {
    const loaded = await Effect.runPromise(loadSandboxCatalog())
    const [happy, apply, failure] = await Effect.runPromise(
      Effect.all(
        [
          runSandboxPresentationTrace({
            loaded,
            scenarioId: 'happy-path',
            directory: path.join(traceDirectory, 'happy-path'),
            runId: 'sandbox-evidence-happy-path',
          }),
          runSandboxPresentationTrace({
            loaded,
            scenarioId: 'apply-happy-path',
            directory: path.join(traceDirectory, 'apply-happy-path'),
            runId: 'sandbox-evidence-apply-happy-path',
          }),
          runSandboxPresentationTrace({
            loaded,
            scenarioId: 'github-lookup-failure',
            directory: path.join(traceDirectory, 'github-lookup-failure'),
            runId: 'sandbox-evidence-github-lookup-failure',
          }),
        ],
        {concurrency: 1},
      ),
    )
    const sourceSha = String(
      (
        await execFileAsync('git', ['log', '-1', '--format=%H', '--', ...EVIDENCE_SOURCE_PATHS], {
          cwd: process.cwd(),
          encoding: 'utf8',
        })
      ).stdout,
    ).trim()
    const fetch = executedState(
      happy,
      (state, origin) => origin === 'progress' && state.phase === 'fetch',
      'fetch progress',
    )
    const map = executedState(
      happy,
      (state, origin) => origin === 'progress' && state.phase === 'map',
      'identity-mapping progress',
    )
    const dryRun = executedState(
      happy,
      (state, origin) => origin === 'progress' && state.phase === 'dry-run',
      'dry-run planning progress',
    )
    const complete = executedState(
      happy,
      (state, origin) =>
        origin === 'progress' && state.phase === 'report' && state.status === 'completed',
      'completed report state',
    )
    const blocked = executedState(
      apply,
      (state, origin) => origin === 'approval' && state.status === 'blocked',
      'blocked approval state',
    )
    const failed = executedState(
      failure,
      (state) => state.status === 'failed',
      'provider failure state',
    )

    const scenarios: readonly EvidenceScenario[] = [
      {
        id: 'wide-live',
        title: 'Wide · live discovery',
        description: 'Executed happy-path source discovery at 120 columns.',
        state: fetch.state,
        columns: 120,
        rows: 30,
        frameIndex: 2,
        trace: {scenarioId: happy.scenarioId, sequence: fetch.sequence},
      },
      {
        id: 'standard-live',
        title: 'Standard · identity matching',
        description: 'Executed happy-path identity matching at a common 80-column viewport.',
        state: map.state,
        columns: 80,
        rows: 20,
        frameIndex: 5,
        trace: {scenarioId: happy.scenarioId, sequence: map.sequence},
      },
      {
        id: 'narrow-live',
        title: 'Narrow · resize edge',
        description: 'Executed happy-path plan construction after a narrow resize.',
        state: dryRun.state,
        columns: 36,
        rows: 8,
        frameIndex: 7,
        trace: {scenarioId: happy.scenarioId, sequence: dryRun.sequence},
      },
      {
        id: 'blocked',
        title: 'Blocked · operator decision',
        description: 'Executed apply scenario paused at the production approval boundary.',
        state: blocked.state,
        columns: 120,
        rows: 30,
        frameIndex: 0,
        trace: {scenarioId: apply.scenarioId, sequence: blocked.sequence},
      },
      {
        id: 'failed',
        title: 'Failure · safe recovery',
        description: 'Executed provider-failure scenario after production recovery signaling.',
        state: failed.state,
        columns: 80,
        rows: 20,
        frameIndex: 0,
        trace: {scenarioId: failure.scenarioId, sequence: failed.sequence},
      },
      {
        id: 'complete',
        title: 'Complete · durable receipt',
        description: 'Executed happy-path completion after the production report writer finished.',
        state: complete.state,
        columns: 120,
        rows: 30,
        frameIndex: 0,
        trace: {scenarioId: happy.scenarioId, sequence: complete.sequence},
      },
      {
        id: 'reduced-motion',
        title: 'Reduced motion · accessible',
        description: 'Executed identity-matching state with the static accessible progress marker.',
        state: map.state,
        columns: 80,
        rows: 20,
        frameIndex: 8,
        reducedMotion: true,
        trace: {scenarioId: happy.scenarioId, sequence: map.sequence},
      },
    ]
    const executedProgress = happy.snapshots.filter(({origin}) => origin === 'progress')
    const animationScenarios: readonly EvidenceScenario[] = Array.from(
      {length: 10},
      (_, frameIndex) => {
        const snapshot =
          executedProgress[Math.min(executedProgress.length - 1, Math.floor(frameIndex / 3))]
        if (!snapshot) {
          throw new Error('Executed happy-path trace produced no progress snapshots.')
        }
        return {
          id: `animation-${frameIndex}`,
          title: 'Executed happy-path progress',
          description: 'Atomic frames across the production orchestrator progress sequence.',
          state: snapshot.state,
          columns: 100,
          rows: 24,
          frameIndex,
          trace: {scenarioId: happy.scenarioId, sequence: snapshot.sequence},
        }
      },
    )
    const allScenarios = [...scenarios, ...animationScenarios]
    const traces = [happy, apply, failure] as const
    const manifest: TuiEvidenceManifest = {
      version: 1,
      sourceSha,
      sourcePaths: EVIDENCE_SOURCE_PATHS,
      catalogDigest: loaded.digest,
      onboardingCommand: 'npm run dev -- --sandbox happy-path',
      executions: traces.map((trace) => ({
        scenarioId: trace.scenarioId,
        runId: trace.runId,
        outcome: trace.outcome,
        ...(trace.failureTag ? {failureTag: trace.failureTag} : {}),
        sequence: trace.snapshots.map(({sequence, origin, state}) => ({
          sequence,
          origin,
          phase: state.phase,
          status: state.status,
          message: state.message,
          ...(state.nextAction ? {nextAction: state.nextAction} : {}),
        })),
      })),
      assets: allScenarios.map((scenario) => ({
        id: scenario.id,
        scenarioId: scenario.trace.scenarioId,
        sequence: scenario.trace.sequence,
        phase: scenario.state.phase,
        status: scenario.state.status,
        columns: scenario.columns,
        rows: scenario.rows,
        reducedMotion: scenario.reducedMotion ?? false,
      })),
    }
    const outputPath = path.join(outputDirectory, 'index.html')
    await Promise.all([
      writeFile(outputPath, renderDocument(scenarios, sourceSha), 'utf8'),
      writeFile(
        path.join(outputDirectory, 'execution-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      ),
      ...allScenarios.map((scenario) =>
        writeFile(
          path.join(outputDirectory, `${scenario.id}.html`),
          renderCapturePage(scenario),
          'utf8',
        ),
      ),
    ])
    console.log(outputPath)
  } finally {
    await rm(traceDirectory, {recursive: true, force: true})
  }
}

await main()
