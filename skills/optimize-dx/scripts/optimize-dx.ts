#!/usr/bin/env -S pnpm exec tsx

// Runnable DX iteration driver. Deterministic. Reads real repo state through the pure
// functions in src/experience/dev-experience.ts, rotates through the area catalog under
// skills/optimize-dx/references/areas/, prints a plain-text summary to stdout, and exits
// truthfully:
//
//   0  — the requested iteration count completed non-destructively. This does NOT claim
//        DX actually converged; DX convergence is a qualitative judgment recorded by Theo
//        in the commit/PR body per references/qualitative-evidence.md.
//   1  — a real error (missing/unreadable package.json, turbo.json, lefthook.yml, or the
//        area catalog index).
//   2  — malformed command-line usage (bad --iterations value or unknown flag).
//
// This driver never fabricates a `converged`, `improved`, or `stopped` claim.

import {readFile} from 'node:fs/promises'
import {existsSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {
  countPackageScripts,
  danglingTurboInputs,
  duplicateFormatConfigCount,
  hookEnforcementStatus,
  documentedScriptRatio,
  type DocumentedScriptCoverage,
  type HookEnforcementStatus,
  type DanglingTurboInput,
} from '../../../src/experience/dev-experience.js'

interface PackageJson {
  readonly scripts?: Readonly<Record<string, unknown>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

interface TurboConfig {
  readonly tasks: Readonly<Record<string, {readonly inputs?: ReadonlyArray<string>}>>
}

const REPO_ROOT = process.cwd()

// Domain-owned default. Deliberately NOT imported from src/experience/persona-experiment.ts:
// the DX loop must stay isolated from the operator experiment so a change to the operator
// baseline cannot silently shift DX iteration semantics. Value chosen to match optimize-ux's
// eight-iteration default for real behavioral parity.
export const DEFAULT_DX_ITERATIONS = 8

// Matches optimize-ux's [1, 20] bound. The area catalog has 11 entries, so 20 iterations
// visits every area at least once (with 9 wrap-around passes). The same message form as
// optimize-ux's resolveIterationCount is used verbatim so contributors who have learned
// one CLI already know the other.
const MIN_DX_ITERATIONS = 1
const MAX_DX_ITERATIONS = 20

// Documented scripts named directly in CONTRIBUTING.md's "Common commands" plus
// docs/testing.md's targeted table. Kept explicit so drift here is deliberate.
const DOCUMENTED_SCRIPTS = [
  'build',
  'dev',
  'test',
  'test:bdd',
  'test:unit',
  'test:contract',
  'test:integration',
  'package:smoke',
  'lint',
  'typecheck',
  'format',
  'format:check',
  'secrets:check',
  'secrets:scan',
  'secrets:validate',
  'check',
  'squad:bootstrap',
  'squad:build',
  'squad:check',
  'squad:doctor',
  'squad:status',
  'squad:copilot',
  'squad:nap',
  'experiment:personas',
  'optimize:ux',
  'optimize:dx',
  'tui:evidence',
  'tui:evidence:render',
  'worker:build',
  'worker:dev',
] as const

// Which of the five supporting numeric signals are meaningful for each area. Empty tuple
// means the area is qualitative-only — most of them are, by design, per
// references/qualitative-evidence.md.
type SignalKey =
  'scriptCount' | 'documentedRatio' | 'hookStatus' | 'prettierConfigCount' | 'danglingTurbo'

export interface DxArea {
  readonly id: string
  readonly title: string
  readonly checklist: string
  readonly signals: ReadonlyArray<SignalKey>
}

// Ordering matches skills/optimize-dx/references/areas/INDEX.md. Do not reorder without
// updating both the index and the rotation tests in test/unit/skills/optimize-dx.test.ts.
export const DX_AREA_CATALOG: ReadonlyArray<DxArea> = [
  {
    id: 'documentation',
    title: 'Documentation — README, CONTRIBUTING, docs/, AGENTS, SKILL.md accuracy',
    checklist: 'skills/optimize-dx/references/areas/documentation.md',
    signals: ['documentedRatio'],
  },
  {
    id: 'repository-structure-and-config',
    title: 'Repository structure and config — root config surface',
    checklist: 'skills/optimize-dx/references/areas/repository-structure-and-config.md',
    signals: ['prettierConfigCount', 'danglingTurbo'],
  },
  {
    id: 'local-environment-and-onboarding',
    title: 'Local environment and onboarding — fresh clone to running local change',
    checklist: 'skills/optimize-dx/references/areas/local-environment-and-onboarding.md',
    signals: ['scriptCount', 'hookStatus'],
  },
  {
    id: 'file-folder-hierarchy',
    title: 'File and folder hierarchy — top-level layout discoverability',
    checklist: 'skills/optimize-dx/references/areas/file-folder-hierarchy.md',
    signals: [],
  },
  {
    id: 'projects-and-workspaces',
    title: 'Projects and workspaces — pnpm-workspace, root vs apps/cli',
    checklist: 'skills/optimize-dx/references/areas/projects-and-workspaces.md',
    signals: [],
  },
  {
    id: 'packages-and-dependencies',
    title: 'Packages and dependencies — package.json, lockfile, overrides, engines',
    checklist: 'skills/optimize-dx/references/areas/packages-and-dependencies.md',
    signals: ['hookStatus'],
  },
  {
    id: 'developer-tools',
    title: 'Developer tools — build, test, lint, debugging',
    checklist: 'skills/optimize-dx/references/areas/developer-tools.md',
    signals: ['scriptCount', 'documentedRatio'],
  },
  {
    id: 'git-hooks',
    title: 'Git hooks — lefthook.yml, pre-commit, pre-push, never bypass',
    checklist: 'skills/optimize-dx/references/areas/git-hooks.md',
    signals: ['hookStatus'],
  },
  {
    id: 'git-github-cli-and-extensions',
    title: 'Git and GitHub CLI — worktree policy, gh usage, extensions',
    checklist: 'skills/optimize-dx/references/areas/git-github-cli-and-extensions.md',
    signals: [],
  },
  {
    id: 'devcontainers',
    title: 'Devcontainers — currently none shipped; honest baseline',
    checklist: 'skills/optimize-dx/references/areas/devcontainers.md',
    signals: [],
  },
  {
    id: 'dotfiles',
    title: 'Dotfiles — no personal-dotfiles convention shipped; honest baseline',
    checklist: 'skills/optimize-dx/references/areas/dotfiles.md',
    signals: [],
  },
] as const

const AREA_INDEX_PATH = 'skills/optimize-dx/references/areas/INDEX.md'

export function resolveIterationCount(raw: string | undefined): number {
  const iterations = raw === undefined ? DEFAULT_DX_ITERATIONS : Number(raw)
  if (
    !Number.isInteger(iterations) ||
    iterations < MIN_DX_ITERATIONS ||
    iterations > MAX_DX_ITERATIONS
  ) {
    throw new Error(
      `--iterations must be an integer from ${MIN_DX_ITERATIONS} through ${MAX_DX_ITERATIONS}`,
    )
  }
  return iterations
}

// Deterministic rotation: `iterations` passes over the catalog in list order, wrapping.
// Returns the sequence of area ids visited. Called from tests with a synthetic catalog
// so no filesystem access is needed for the rotation contract.
export function rotateAreas(
  iterations: number,
  catalog: ReadonlyArray<{readonly id: string}>,
): ReadonlyArray<string> {
  if (catalog.length === 0) return []
  const visited: string[] = []
  for (let i = 0; i < iterations; i++) {
    const entry = catalog[i % catalog.length]
    if (entry) visited.push(entry.id)
  }
  return visited
}

interface SignalSnapshot {
  readonly scriptCount: number
  readonly documentedRatio: DocumentedScriptCoverage
  readonly hookStatus: HookEnforcementStatus
  readonly prettierConfigCount: number
  readonly danglingTurbo: ReadonlyArray<DanglingTurboInput>
}

async function readJson<T>(relative: string): Promise<T> {
  const raw = await readFile(path.join(REPO_ROOT, relative), 'utf8')
  return JSON.parse(raw) as T
}

function fileExists(relative: string): boolean {
  return existsSync(path.join(REPO_ROOT, relative))
}

const USAGE = [
  'Usage: pnpm optimize:dx [-- --iterations <n>]',
  '',
  `  --iterations <n>  Area-catalog rotation count. Default when omitted: ${DEFAULT_DX_ITERATIONS}.`,
  `                    Integer in [${MIN_DX_ITERATIONS}, ${MAX_DX_ITERATIONS}].`,
  '',
  'Exit codes:',
  '  0 = requested iteration count completed non-destructively (NOT a DX-converged claim)',
  '  1 = real error (missing package.json, turbo.json, lefthook.yml, or area catalog)',
  '  2 = malformed usage',
].join('\n')

interface ParsedArgs {
  readonly iterations: number
}

// Explicit argv scan: this script has one mode (rotate), not the cycle/validate/status
// commands optimize-ux exposes, so a full multi-command parser is unnecessary here.
export function parseCliArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let iterationsRaw: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--iterations') {
      iterationsRaw = argv[i + 1]
      i += 1
      continue
    }
    if (token !== undefined && token.startsWith('--iterations=')) {
      iterationsRaw = token.slice('--iterations='.length)
      continue
    }
    if (token === '--help' || token === '-h') {
      throw new Error('__HELP__')
    }
    throw new Error(`Unknown option ${token}`)
  }
  return {iterations: resolveIterationCount(iterationsRaw)}
}

function formatSignal(key: SignalKey, snapshot: SignalSnapshot): string {
  switch (key) {
    case 'scriptCount':
      return `Root pnpm script count: ${snapshot.scriptCount}`
    case 'documentedRatio': {
      const {documented, total, ratio} = snapshot.documentedRatio
      return `Documented script coverage: ${documented}/${total} (${(ratio * 100).toFixed(1)}%)`
    }
    case 'hookStatus':
      return `Git-hook enforcement status: ${snapshot.hookStatus}`
    case 'prettierConfigCount':
      return `Prettier config files at repo root: ${snapshot.prettierConfigCount}`
    case 'danglingTurbo': {
      if (snapshot.danglingTurbo.length === 0) return 'Dangling turbo.json inputs: none'
      const listed = snapshot.danglingTurbo.map(({task, input}) => `${task}:${input}`).join(', ')
      return `Dangling turbo.json inputs: ${snapshot.danglingTurbo.length} (${listed})`
    }
  }
}

async function loadSnapshot(): Promise<SignalSnapshot> {
  const pkg = await readJson<PackageJson>('package.json')
  const turbo = await readJson<TurboConfig>('turbo.json')
  const rootEntries = readdirSync(REPO_ROOT)
  const scriptNames = pkg.scripts ? Object.keys(pkg.scripts) : []
  return {
    scriptCount: countPackageScripts(pkg),
    documentedRatio: documentedScriptRatio(scriptNames, [...DOCUMENTED_SCRIPTS]),
    hookStatus: hookEnforcementStatus({
      hasLefthookConfig: fileExists('lefthook.yml'),
      hasLefthookDependency: Boolean(pkg.devDependencies?.lefthook),
    }),
    prettierConfigCount: duplicateFormatConfigCount(rootEntries),
    danglingTurbo: danglingTurboInputs(turbo, fileExists),
  }
}

async function main(): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '__HELP__') {
      process.stdout.write(`${USAGE}\n`)
      return
    }
    process.stderr.write(`${message}\n${USAGE}\n`)
    process.exitCode = 2
    return
  }

  if (!fileExists(AREA_INDEX_PATH)) {
    process.stderr.write(
      `optimize-dx failed: area catalog missing at ${AREA_INDEX_PATH}. Restore skills/optimize-dx/references/areas/INDEX.md before running.\n`,
    )
    process.exitCode = 1
    return
  }

  let snapshot: SignalSnapshot
  try {
    snapshot = await loadSnapshot()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`optimize-dx failed: ${message}\n`)
    process.exitCode = 1
    return
  }

  const {iterations} = parsed
  const visited = rotateAreas(iterations, DX_AREA_CATALOG)

  const lines: string[] = []
  lines.push('# optimize-dx area rotation')
  lines.push('')
  lines.push('Qualitative DX critique is the verdict; this rotation surfaces supporting inputs.')
  lines.push(`Area catalog: ${AREA_INDEX_PATH} (${DX_AREA_CATALOG.length} areas)`)
  lines.push(`Iterations requested: ${iterations}`)
  lines.push('')

  for (let i = 0; i < iterations; i++) {
    const area = DX_AREA_CATALOG[i % DX_AREA_CATALOG.length]
    if (!area) continue
    lines.push(`## Iteration ${i + 1} — area: ${area.id}`)
    lines.push(area.title)
    lines.push(`Checklist: ${area.checklist}`)
    if (area.signals.length === 0) {
      lines.push('Supporting signals: none (qualitative area).')
    } else {
      lines.push('Supporting signals:')
      for (const signal of area.signals) {
        lines.push(`  - ${formatSignal(signal, snapshot)}`)
      }
    }
    lines.push('')
  }

  lines.push('## Summary')
  lines.push(`iterationsRequested: ${iterations}`)
  lines.push(`iterationsCompleted: ${visited.length}`)
  lines.push(`areasVisited: ${visited.join(', ')}`)
  lines.push("runStatus: 'completed'")
  lines.push('')
  lines.push('runStatus reports only that the requested passes finished without error. Whether the')
  lines.push(
    'developer experience actually improved or converged is a qualitative judgment recorded',
  )
  lines.push(
    'by Theo in the commit/PR body per skills/optimize-dx/references/qualitative-evidence.md.',
  )
  lines.push('The drift gate is test/unit/documentation/dx-docs.test.ts.')

  process.stdout.write(`${lines.join('\n')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`optimize-dx failed: ${message}\n`)
    process.exit(1)
  })
}
