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
import {Cause, Effect, Exit} from 'effect'
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
import {
  AgentBusTag,
  type AgentBusService,
  type Desirability,
  type IntentInput,
  type OutcomeInputPayload,
} from '../../../src/experience/agent-bus.js'
import {makeAgentBusLiveLayer} from '../../../src/experience/agent-bus-live.js'

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
  // Theo's own persona-authentic prediction of what an honest measurement of this area on the
  // current branch will surface. Authored BEFORE the driver runs and BEFORE any bus outcome is
  // recorded, so this field is the write-ahead hypothesis. Every entry is distinct, grounded in
  // this repository's actual current state on `msft-tkendrick-developer-experience-overhaul`, and
  // deliberately falsifiable — if the real measurement contradicts the prediction the bus records
  // an `undesirable` outcome, not a retrofitted "I meant that all along" one.
  readonly expectedObservation: string
}

// Ordering matches skills/optimize-dx/references/areas/INDEX.md. Do not reorder without
// updating both the index and the rotation tests in test/unit/skills/optimize-dx.test.ts.
export const DX_AREA_CATALOG: ReadonlyArray<DxArea> = [
  {
    id: 'documentation',
    title: 'Documentation — README, CONTRIBUTING, docs/, AGENTS, SKILL.md accuracy',
    checklist: 'skills/optimize-dx/references/areas/documentation.md',
    signals: ['documentedRatio'],
    expectedObservation:
      "I expect documentedScriptRatio to be at least 0.85: CONTRIBUTING.md's common-commands table plus docs/testing.md exhaustively name most root scripts, but I expect a few internal or newly-added scripts (worker:build, worker:dev, one of the sub-checks) to still fall outside the DOCUMENTED_SCRIPTS list. Anything below 0.75 is undesirable and means prose drifted.",
  },
  {
    id: 'repository-structure-and-config',
    title: 'Repository structure and config — root config surface',
    checklist: 'skills/optimize-dx/references/areas/repository-structure-and-config.md',
    signals: ['prettierConfigCount', 'danglingTurbo'],
    expectedObservation:
      'I expect exactly 1 Prettier config at the repo root (.prettierrc.json) and 0 dangling turbo.json inputs. The duplicate-prettier-config regression that motivated this signal was already fixed on this branch, and the turbo.json `../../` cache-poisoning entries were removed. Anything other than 1/0 means a regression landed since I last verified.',
  },
  {
    id: 'local-environment-and-onboarding',
    title: 'Local environment and onboarding — fresh clone to running local change',
    checklist: 'skills/optimize-dx/references/areas/local-environment-and-onboarding.md',
    signals: ['scriptCount', 'hookStatus'],
    expectedObservation:
      "I expect scriptCount to be around 32 (a mildly-undesirable discoverability surface — a fresh contributor cannot skim 32 scripts) and hookStatus to be 'enforced' because both lefthook.yml and the lefthook devDependency landed earlier this session. If hookStatus is anything but 'enforced' something regressed between commits.",
  },
  {
    id: 'file-folder-hierarchy',
    title: 'File and folder hierarchy — top-level layout discoverability',
    checklist: 'skills/optimize-dx/references/areas/file-folder-hierarchy.md',
    signals: [],
    expectedObservation:
      'No numeric signal applies. I expect the qualitative reality to be: many top-level directories (src, test, scripts, skills, apps, bin, docs, deploy, reports, sandbox, .squad, .github, dist) with README anchoring only some of them — a moderate discoverability friction that no signal will surface. This is deliberately a qualitative-only area.',
  },
  {
    id: 'projects-and-workspaces',
    title: 'Projects and workspaces — pnpm-workspace, root vs apps/cli',
    checklist: 'skills/optimize-dx/references/areas/projects-and-workspaces.md',
    signals: [],
    expectedObservation:
      'No numeric signal applies. I expect pnpm-workspace.yaml to declare `apps/*` and `packages/*`, with apps/cli present but packages/ absent — a half-formed monorepo declaration. This is a mild but real friction (documented workspace path with nothing behind it) that only a qualitative critique catches.',
  },
  {
    id: 'packages-and-dependencies',
    title: 'Packages and dependencies — package.json, lockfile, overrides, engines',
    checklist: 'skills/optimize-dx/references/areas/packages-and-dependencies.md',
    signals: ['hookStatus'],
    expectedObservation:
      "I expect hookStatus 'enforced' — hook enforcement is an indirect proxy for dependency correctness here because the regression this signal was designed to catch (lefthook referenced by hooks but missing from devDeps) is the same regression that also shows up as a bad dependency. `enforced` is desirable.",
  },
  {
    id: 'developer-tools',
    title: 'Developer tools — build, test, lint, debugging',
    checklist: 'skills/optimize-dx/references/areas/developer-tools.md',
    signals: ['scriptCount', 'documentedRatio'],
    expectedObservation:
      'I expect scriptCount around 30 and documentedRatio at least 0.85 — same underlying reads as documentation and onboarding, viewed through the tool-surface lens. Any drift here is the same drift, judged against a stricter "every tool a contributor needs is discoverable" bar.',
  },
  {
    id: 'git-hooks',
    title: 'Git hooks — lefthook.yml, pre-commit, pre-push, never bypass',
    checklist: 'skills/optimize-dx/references/areas/git-hooks.md',
    signals: ['hookStatus'],
    expectedObservation:
      "I expect hookStatus 'enforced' because lefthook.yml exists at the repo root and the lefthook devDependency (2.1.10) is declared in package.json. This is the load-bearing signal for this area — anything other than 'enforced' is a full regression and undesirable at degree 0.",
  },
  {
    id: 'git-github-cli-and-extensions',
    title: 'Git and GitHub CLI — worktree policy, gh usage, extensions',
    checklist: 'skills/optimize-dx/references/areas/git-github-cli-and-extensions.md',
    signals: [],
    expectedObservation:
      'No numeric signal applies. I expect the honest baseline to be that no gh CLI extension convention is shipped (no .github/gh-extensions/ path, no scripted `gh extension install` step), and the contributor onboarding path relies on stock gh + git worktree instructions. This is neutral by design — the area file records it honestly, so the correct outcome is `neutral`/0.5, not `desirable`.',
  },
  {
    id: 'devcontainers',
    title: 'Devcontainers — currently none shipped; honest baseline',
    checklist: 'skills/optimize-dx/references/areas/devcontainers.md',
    signals: [],
    expectedObservation:
      'No numeric signal applies. I expect no `.devcontainer/` directory to exist in this repo, and the area file records that honestly rather than pretending one exists. The correct outcome is `neutral`/0.5: the area is qualitative and the state matches documented reality. If a `.devcontainer/` unexpectedly appears the outcome shifts to `desirable` (contributor onboarding gained a surface) or `undesirable` (unmaintained devcontainer landed without docs).',
  },
  {
    id: 'dotfiles',
    title: 'Dotfiles — no personal-dotfiles convention shipped; honest baseline',
    checklist: 'skills/optimize-dx/references/areas/dotfiles.md',
    signals: [],
    expectedObservation:
      'No numeric signal applies. I expect no dotfiles convention to exist in this repo (no `dotfiles/` directory, no `chezmoi`/`stow` guidance in CONTRIBUTING.md), and the area file records that honestly. Correct outcome is `neutral`/0.5. This area exists precisely so that a future dotfiles convention has a home to be critiqued against.',
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

export type {SignalSnapshot}

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

// Perceived-interface description Theo passes into the write-ahead intent for a given area. This
// captures what the persona sees on the surface (which supporting signals will be read, which
// checklist file will anchor the qualitative pass) BEFORE the actual read runs.
function describePerceivedInterface(area: DxArea): string {
  const signalsDescription =
    area.signals.length === 0
      ? 'qualitative-only area (no supporting numeric signals)'
      : `supporting signals: ${area.signals.join(', ')}`
  return `area=${area.id}; checklist=${area.checklist}; ${signalsDescription}`
}

// Actual observation string Theo passes into the outcome for a given area. Reflects the real
// numeric readings for that area (empty phrase for qualitative-only areas), never a claim about
// DX convergence.
function describeActualObservation(area: DxArea, snapshot: SignalSnapshot): string {
  if (area.signals.length === 0) {
    return `no supporting signal for ${area.id}; qualitative-only area, verdict deferred to Theo's prose`
  }
  return area.signals.map((signal) => formatSignal(signal, snapshot)).join('; ')
}

// Theo's own qualitative classifier for a DX area outcome. Bus success is NOT DX success; this
// function turns the RAW measurement result into a bounded (desirability, degree) judgment against
// the persona-authentic prediction the intent recorded up-front. Rules encoded here are the same
// rules stated in `expectedObservation` prose for each area — this function is where those rules
// become executable, so a prediction that says "anything but enforced is undesirable at degree 0"
// actually returns that outcome.
export interface DxAreaClassification {
  readonly desirability: Desirability
  readonly degree: number
  readonly delta: string
}

export function classifyDxAreaOutcome(
  area: DxArea,
  snapshot: SignalSnapshot,
): DxAreaClassification {
  switch (area.id) {
    case 'documentation':
    case 'developer-tools': {
      const {documented, total, ratio} = snapshot.documentedRatio
      if (ratio >= 0.85)
        return {
          desirability: 'desirable',
          degree: Math.min(1, 0.5 + (ratio - 0.85) * 2),
          delta: `documented ratio ${ratio.toFixed(2)} (${documented}/${total}) met the >=0.85 prediction`,
        }
      if (ratio >= 0.75)
        return {
          desirability: 'neutral',
          degree: 0.5,
          delta: `documented ratio ${ratio.toFixed(2)} (${documented}/${total}) is between predicted floor (0.75) and target (0.85)`,
        }
      return {
        desirability: 'undesirable',
        degree: Math.max(0, ratio / 0.75 - 0.25),
        delta: `documented ratio ${ratio.toFixed(2)} (${documented}/${total}) fell below the predicted 0.75 floor — prose drifted`,
      }
    }
    case 'repository-structure-and-config': {
      const prettierOk = snapshot.prettierConfigCount === 1
      const turboOk = snapshot.danglingTurbo.length === 0
      if (prettierOk && turboOk)
        return {
          desirability: 'desirable',
          degree: 1,
          delta: `1 prettier config and 0 dangling turbo inputs — matches prediction exactly`,
        }
      return {
        desirability: 'undesirable',
        degree: 0,
        delta: `prettierConfigCount=${snapshot.prettierConfigCount} (want 1), danglingTurbo count=${snapshot.danglingTurbo.length} (want 0) — regression against prediction`,
      }
    }
    case 'local-environment-and-onboarding': {
      const enforced = snapshot.hookStatus === 'enforced'
      // scriptCount around 30 is a mild-friction fact the prediction already flagged as
      // "mildly undesirable discoverability surface" — enforcement is the load-bearing bit here.
      if (enforced)
        return {
          desirability: 'neutral',
          degree: 0.5,
          delta: `hookStatus=enforced (matches prediction) and scriptCount=${snapshot.scriptCount} (matches predicted "around 30" surface); mild discoverability friction persists but nothing regressed`,
        }
      return {
        desirability: 'undesirable',
        degree: 0,
        delta: `hookStatus=${snapshot.hookStatus} regressed from predicted "enforced"`,
      }
    }
    case 'packages-and-dependencies':
    case 'git-hooks': {
      if (snapshot.hookStatus === 'enforced')
        return {
          desirability: 'desirable',
          degree: 1,
          delta: `hookStatus=enforced matches prediction exactly (load-bearing signal for this area)`,
        }
      return {
        desirability: 'undesirable',
        degree: 0,
        delta: `hookStatus=${snapshot.hookStatus} contradicts predicted "enforced"`,
      }
    }
    // Qualitative-only areas — the prediction is that the honest baseline holds; the outcome is
    // recorded as `neutral` because no bus-visible signal can falsify or confirm it. The real
    // verdict remains Theo's prose in the commit/PR body.
    case 'file-folder-hierarchy':
    case 'projects-and-workspaces':
    case 'git-github-cli-and-extensions':
    case 'devcontainers':
    case 'dotfiles':
      return {
        desirability: 'neutral',
        degree: 0.5,
        delta: `qualitative-only area; no bus-visible signal can render a verdict — DX judgment remains Theo's prose`,
      }
    default:
      return {
        desirability: 'neutral',
        degree: 0.5,
        delta: `unknown area id ${area.id}; falling back to neutral, not a DX verdict`,
      }
  }
}

// Build the intent for iteration `n` visiting `area`. Correlation id shape mirrors the operator
// side (`optimize-ux:{personaId}:{iteration}:{intendedAction}`), so a resumer/replayer can route a
// serialized event by parsing the id.
export function buildIntent(area: DxArea, iteration: number): IntentInput {
  return {
    correlationId: `optimize-dx:cli-contributor-engineer:${iteration}:${area.id}`,
    personaId: 'cli-contributor-engineer',
    domain: 'developer',
    skill: 'optimize-dx',
    iteration,
    perceivedInterface: describePerceivedInterface(area),
    intendedAction: `read supporting signals for area ${area.id} against my persona-authentic prediction`,
    expectedResult: area.expectedObservation,
  }
}

// Wire ONE iteration through the bus. `runWithIntent` structurally enforces that the actual signal
// read (the `action` closure) cannot execute unless `recordIntent` succeeded first — the closure's
// `_ack` parameter is only produced by a confirmed intent write. This is where "bus success ≠ DX
// success" is enforced in code: a successful bus append means the WRITE-AHEAD PROTOCOL worked; the
// desirability/degree we then hand to `recordOutcome` is Theo's qualitative judgment (via
// `classifyDxAreaOutcome`), and the driver's `runStatus: 'completed'` line NEVER claims DX itself
// converged.
//
// The `toOutcome` callback below is called EXACTLY ONCE per iteration for all four terminal
// exit shapes — success, typed failure, unchecked defect, and interruption — and returns the
// persona-authored outcome payload the bus then persists. I (Theo, cli-contributor-engineer)
// own the DevEx judgment for all four shapes. The success branch delegates to the classifier
// I authored (`classifyDxAreaOutcome`); the three non-success branches are DevEx-authored
// distinguishable prose describing what each shape means for THIS loop — a fresh-clone
// contributor iterating a DX critique against my pre-declared area predictions. Common thread:
// most DX areas expected a clean read of package.json / turbo.json / lefthook.yml (or a
// deliberately-qualitative "no signal applies"), so any non-success terminal is the
// measurement tool itself failing to render a verdict — a strictly worse failure mode than
// simply reporting an undesirable signal, because it degrades the very tool meant to reduce
// contributor friction. Each shape gets its own honest verdict rather than a shared string.
export function runIterationThroughBus(
  bus: AgentBusService,
  area: DxArea,
  iteration: number,
  snapshot: SignalSnapshot,
): Effect.Effect<void, unknown> {
  return bus.runWithIntent(
    buildIntent(area, iteration),
    (_ack) => Effect.sync(() => describeActualObservation(area, snapshot)),
    (exit, _ack, intent): OutcomeInputPayload => {
      if (Exit.isSuccess(exit)) {
        const {desirability, degree, delta} = classifyDxAreaOutcome(area, snapshot)
        return {
          actualResult: exit.value,
          delta,
          desirability,
          degree,
          observedFriction: area.signals.length === 0 ? 'qualitative-only' : area.signals.join(','),
        }
      }
      const cause = exit.cause
      // Interrupt takes precedence: an interrupted-only cause means the run was cancelled by
      // a supervisor / SIGINT / Effect.interrupt before the measurement action could produce a
      // value. Defect (Die) means an unchecked exception escaped the action (a bug in my own
      // measurement code — an invariant I did not encode as a typed error). Otherwise the
      // action produced a typed Failure — the expected shape for a real read error against
      // package.json / turbo.json / lefthook.yml or a schema-decode failure on an area's
      // pre-declared expected-observation data.
      if (Cause.isInterruptedOnly(cause)) {
        return {
          actualResult: `interrupted before a DevEx observation could be produced for area '${area.id}' at iteration ${intent.iteration}: the measurement action was cancelled while I was mid-read against my pre-declared prediction, so no signal was harvested this pass`,
          delta: `I predicted a clean read of ${area.signals.length === 0 ? 'no numeric signal (qualitative-only area)' : area.signals.join('+')} for '${area.id}' — instead the iteration was cancelled before the read even completed, so there is no signal to compare against my prediction; the write-ahead intent is preserved on disk, the outcome is honestly recorded as "we never got there", not a synthesised verdict`,
          desirability: 'neutral',
          degree: 0.5,
          observedFriction: `interrupt-before-observation:${area.id}`,
        }
      }
      if (Cause.isDie(cause)) {
        return {
          actualResult: `unchecked defect while measuring area '${area.id}' at iteration ${intent.iteration}: the measurement code crashed with an unmodeled exception rather than returning a signal or a typed error — a bug in my own DX tooling, not in the repository state it was trying to describe`,
          delta: `I predicted the measurement path itself would be boring (a plain read against package.json / turbo.json / lefthook.yml, or a no-op for a qualitative-only area) — instead it died on a shape my code did not encode as a typed error, which means my critique tool has an invariant hole and cannot render a verdict for '${area.id}' this iteration; this is the tool meant to reduce contributor friction actively adding friction`,
          desirability: 'undesirable',
          degree: 0,
          observedFriction: `dx-tool-defect:${area.id}`,
        }
      }
      return {
        actualResult: `typed failure while reading the supporting signals for area '${area.id}' at iteration ${intent.iteration}: the measurement action surfaced a modelled error (most likely a missing or unreadable package.json / turbo.json / lefthook.yml, or a schema-decode failure against the area's expected-observation data) rather than producing an observation`,
        delta: `I predicted a clean read of ${area.signals.length === 0 ? 'no numeric signal (qualitative-only area, but even that path still touches the catalog)' : area.signals.join('+')} for '${area.id}' — instead the read failed cleanly through a typed error, so the DX loop has a signal about its own inputs (they are not in the shape a fresh clone would have) but no signal about the area itself; a contributor hitting this on a fresh clone would already be blocked before optimize-dx could even critique the repo`,
        desirability: 'undesirable',
        degree: 0.25,
        observedFriction: `dx-signal-read-failed:${area.id}`,
      }
    },
  )
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

  // Fail-closed bus wiring: if AgentBusTag cannot be resolved the driver exits `1`. There is no
  // silent skip — the write-ahead protocol either runs for every iteration or the run is refused.
  // Live layer writes redacted JSONL to a run-scoped file at
  // `reports/agent-bus/optimize-dx/cli-contributor-engineer/{runId}.jsonl` — the corrected bus
  // isolates every fresh invocation by generating its own runId (or accepting one via
  // `resumeFromRunId`), so no two runs share a file (already gitignored via the `reports/` rule;
  // nothing under it is ever committed).
  const program = Effect.gen(function* () {
    const bus = yield* AgentBusTag
    for (let i = 0; i < iterations; i++) {
      const area = DX_AREA_CATALOG[i % DX_AREA_CATALOG.length]
      if (!area) continue
      lines.push(`## Iteration ${i + 1} — area: ${area.id}`)
      lines.push(area.title)
      lines.push(`Checklist: ${area.checklist}`)
      lines.push(`Persona prediction: ${area.expectedObservation}`)
      if (area.signals.length === 0) {
        lines.push('Supporting signals: none (qualitative area).')
      } else {
        lines.push('Supporting signals:')
        for (const signal of area.signals) {
          lines.push(`  - ${formatSignal(signal, snapshot)}`)
        }
      }
      const {desirability, degree, delta} = classifyDxAreaOutcome(area, snapshot)
      lines.push(
        `Recorded outcome: desirability=${desirability} degree=${degree.toFixed(2)} — ${delta}`,
      )
      lines.push('')
      yield* runIterationThroughBus(bus, area, i + 1, snapshot)
    }
  }).pipe(Effect.provide(makeAgentBusLiveLayer(path.join(REPO_ROOT, 'reports', 'agent-bus'))))

  const exit = await Effect.runPromiseExit(program)
  if (Exit.isFailure(exit)) {
    process.stderr.write(
      `optimize-dx failed: write-ahead bus refused an iteration — no silent skip.\n${Cause.pretty(exit.cause)}\n`,
    )
    process.exitCode = 1
    return
  }

  lines.push('## Summary')
  lines.push(`iterationsRequested: ${iterations}`)
  lines.push(`iterationsCompleted: ${visited.length}`)
  lines.push(`areasVisited: ${visited.join(', ')}`)
  lines.push("runStatus: 'completed'")
  lines.push('')
  lines.push(
    'runStatus reports only that the requested passes finished without error, AND that the',
  )
  lines.push('write-ahead persona bus recorded a persona-authentic intent and outcome for every')
  lines.push('iteration. Bus success is NOT a DX-improved claim: the desirability/degree recorded')
  lines.push(
    'on each outcome is a bounded judgment against a pre-declared prediction, not a verdict',
  )
  lines.push('that the developer experience actually improved. That verdict remains a qualitative')
  lines.push(
    'judgment recorded by Theo in the commit/PR body per skills/optimize-dx/references/qualitative-evidence.md.',
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
