// Deterministic, pure measurements for the developer-experience evidence loop.
// These functions consume already-loaded data so they are trivially unit-testable
// without touching the filesystem. Live measurements happen at the caller.

import {Schema} from 'effect'

export interface PackageJsonLike {
  readonly scripts?: Readonly<Record<string, unknown>>
}

export interface DocumentedScriptCoverage {
  readonly documented: number
  readonly total: number
  readonly ratio: number
}

export type HookEnforcementStatus = 'enforced' | 'fail-open' | 'absent'

export interface HookEnforcementInput {
  readonly hasLefthookConfig: boolean
  readonly hasLefthookDependency: boolean
}

export interface TurboConfigLike {
  readonly tasks: Readonly<Record<string, {readonly inputs?: ReadonlyArray<string>}>>
}

export interface DanglingTurboInput {
  readonly task: string
  readonly input: string
}

// A repository is expected to have exactly one active Prettier configuration file.
// Every entry a Prettier resolver recognizes at the repo root:
export const PRETTIER_CONFIG_CANDIDATES = [
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
] as const

// Turbo tokens that legitimately appear in `inputs` but are not real file paths.
const TURBO_SPECIAL_TOKENS: ReadonlySet<string> = new Set(['$TURBO_DEFAULT$'])

export function countPackageScripts(pkg: PackageJsonLike): number {
  const scripts = pkg.scripts
  if (!scripts) return 0
  return Object.keys(scripts).length
}

export function documentedScriptRatio(
  scripts: readonly string[],
  documented: readonly string[],
): DocumentedScriptCoverage {
  const total = scripts.length
  if (total === 0) return {documented: 0, total: 0, ratio: 1}
  const documentedSet = new Set(documented)
  const matched = scripts.filter((script) => documentedSet.has(script)).length
  return {documented: matched, total, ratio: matched / total}
}

export const INTENTIONAL_INTERNAL_SCRIPTS = [
  'secrets:validate',
  'squad:copilot',
  'tui:evidence:render',
] as const

export function extractPnpmScriptReferences(sources: readonly string[]): ReadonlyArray<string> {
  const found = new Set<string>()
  for (const source of sources) {
    const regex = /`pnpm ([a-z][a-z0-9:-]*)/g
    for (const match of source.matchAll(regex)) {
      const name = match[1]
      if (name !== undefined && name.length > 0) found.add(name)
    }
  }
  return [...found]
}

export function hookEnforcementStatus(input: HookEnforcementInput): HookEnforcementStatus {
  const {hasLefthookConfig, hasLefthookDependency} = input
  if (hasLefthookConfig && hasLefthookDependency) return 'enforced'
  if (!hasLefthookConfig && !hasLefthookDependency) return 'absent'
  // Either alone is a fail-open state: the git hook exists but nothing enforces
  // it, or the dep exists but no config drives any real check.
  return 'fail-open'
}

export function duplicateFormatConfigCount(files: readonly string[]): number {
  const present = new Set(files)
  return PRETTIER_CONFIG_CANDIDATES.filter((candidate) => present.has(candidate)).length
}

export function danglingTurboInputs(
  turboConfig: TurboConfigLike,
  existingFiles: (path: string) => boolean,
): ReadonlyArray<DanglingTurboInput> {
  const findings: DanglingTurboInput[] = []
  for (const [task, definition] of Object.entries(turboConfig.tasks)) {
    const inputs = definition.inputs ?? []
    for (const input of inputs) {
      if (TURBO_SPECIAL_TOKENS.has(input)) continue
      if (!existingFiles(input)) findings.push({task, input})
    }
  }
  return findings
}

// Optional, env-gated live timing helper. This DOES touch the filesystem and
// spawns child processes, so it never runs unless the caller explicitly opts in
// with DX_MEASURE_TIMING=1. CI does not set this.
export interface CommandTimingResult {
  readonly command: string
  readonly durationMs: number
  readonly exitCode: number
}

export interface CommandTimingRunner {
  readonly measure: (command: string, args: readonly string[]) => Promise<CommandTimingResult>
}

export function isTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DX_MEASURE_TIMING === '1'
}

// -------------------------------------------------------------------------------------------------
// Isolated developer-experience journey registry.
//
// DEVEX_JOURNEYS is deliberately kept separate from CLI_JOURNEYS. Its persona field is structurally
// constrained to 'cli-contributor-engineer' so an operator persona id cannot appear here even if
// someone forgets the intent. Only the contributor persona (Theo) participates in DevEx evidence.
// -------------------------------------------------------------------------------------------------

export const DevExPersonaSchema = Schema.Literal('cli-contributor-engineer')
export type DevExPersonaId = Schema.Schema.Type<typeof DevExPersonaSchema>

const DevExJourneySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  persona: DevExPersonaSchema,
  touchpoint: Schema.String,
  measurement: Schema.String,
  steps: Schema.optional(Schema.Array(Schema.String)),
  evidence: Schema.optional(Schema.Array(Schema.String)),
})

export type DevExJourney = Schema.Schema.Type<typeof DevExJourneySchema>

export const DEVEX_JOURNEYS = Schema.decodeUnknownSync(Schema.Array(DevExJourneySchema))([
  {
    id: 'discover-dev-command-surface',
    title: 'Discover the pnpm dev-command surface without reading every script',
    persona: 'cli-contributor-engineer',
    touchpoint: 'pnpm run',
    measurement: 'countPackageScripts + documentedScriptRatio',
  },
  {
    id: 'enforced-pre-commit-hook',
    title: 'Trust that pre-commit and pre-push actually run, not silently skip',
    persona: 'cli-contributor-engineer',
    touchpoint: 'git commit',
    measurement: 'hookEnforcementStatus',
  },
  {
    id: 'single-source-formatting-config',
    title: 'Format with exactly one Prettier configuration, not competing ones',
    persona: 'cli-contributor-engineer',
    touchpoint: 'pnpm format',
    measurement: 'duplicateFormatConfigCount',
  },
  {
    id: 'reliable-turbo-cache-inputs',
    title: 'Rely on turbo caching without dangling input paths that break invalidation',
    persona: 'cli-contributor-engineer',
    touchpoint: 'pnpm build / pnpm lint',
    measurement: 'danglingTurboInputs',
  },
  {
    id: 'focused-validation-loop',
    title: 'Iterate through format:check + lint + typecheck + test:unit without full-gate friction',
    persona: 'cli-contributor-engineer',
    touchpoint: 'pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit',
    // No single pure function models this end-to-end; it anchors the scopeRepetition sensitivity
    // qualitatively and is defended by the lefthook pre-push subset and CONTRIBUTING.md prose.
    measurement: 'qualitative — anchors scopeRepetition; validated via lefthook pre-push and docs',
  },
  {
    id: 'ship-and-consume-cli',
    title: 'Package, install, invoke, configure, deploy, diagnose, and update the shipped CLI',
    persona: 'cli-contributor-engineer',
    touchpoint:
      '@msft-tkendrick/a2g tarball, packaged a2g help, world preflight, release policy, and Azure Workflow artifact',
    measurement:
      'registry availability, two-command clean-consumer install, executable package, release-policy, World selection, and supported-host artifact contracts; documentation-only and source-fallback evidence is rejected',
    steps: [
      'Resolve `@msft-tkendrick/a2g@preview`, then prove a clean consumer needs exactly one install command and one verification command; block if the dist-tag is unavailable.',
      'Inspect the dry-run tarball and confirm public package metadata and required runtime files.',
      'Invoke packaged `a2g --help` and `a2g world --help`; confirm the short primary name and truthful preflight wording.',
      'Verify plain `0.x.x` versions, the `preview` publication channel, provenance, and GitHub prerelease policy.',
      'Verify local remains the default and Azure requires sign-in, an accessible subscription, and explicit selection.',
      'Build the Azure Workflow artifact on Ubuntu x64 and inspect its public manifest, handlers, and Oryx source-package requirements.',
      'Exercise failure and diagnostic paths for no subscription, inaccessible selection, and unsupported build hosts.',
    ],
    evidence: [
      'pnpm package:smoke',
      '.github/workflows/release.yml post-publish clean consumer install',
      'pnpm test:unit -- test/unit/release/version-policy.test.ts test/unit/workflow/selection.test.ts',
      'pnpm azure:build (Ubuntu x64 CI)',
      'README.md and docs/using-the-cli.md consumer and deployment instructions',
    ],
  },
])
