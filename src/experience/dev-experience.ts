// Deterministic, pure measurements for the developer-experience evidence loop.
// These functions consume already-loaded data so they are trivially unit-testable
// without touching the filesystem. Live measurements happen at the caller.

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
