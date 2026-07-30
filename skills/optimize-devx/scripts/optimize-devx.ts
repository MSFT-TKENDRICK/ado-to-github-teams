#!/usr/bin/env -S pnpm exec tsx

// Runnable DX measurement report. Deterministic. Reads real repo state through
// the pure functions in src/experience/dev-experience.ts, prints a plain-text
// summary to stdout, and exits 0 whether or not there is drift — this is a
// report, not a gate. The gate lives in test/unit/documentation/devx-docs.test.ts.

import {readFile} from 'node:fs/promises'
import {existsSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {
  countPackageScripts,
  danglingTurboInputs,
  duplicateFormatConfigCount,
  hookEnforcementStatus,
  documentedScriptRatio,
} from '../../../src/experience/dev-experience.js'

interface PackageJson {
  readonly scripts?: Readonly<Record<string, unknown>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

interface TurboConfig {
  readonly tasks: Readonly<Record<string, {readonly inputs?: ReadonlyArray<string>}>>
}

const REPO_ROOT = process.cwd()

async function readJson<T>(relative: string): Promise<T> {
  const raw = await readFile(path.join(REPO_ROOT, relative), 'utf8')
  return JSON.parse(raw) as T
}

function fileExists(relative: string): boolean {
  return existsSync(path.join(REPO_ROOT, relative))
}

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
  'optimize:devx',
  'tui:evidence',
  'tui:evidence:render',
  'worker:build',
  'worker:dev',
] as const

async function main(): Promise<void> {
  const pkg = await readJson<PackageJson>('package.json')
  const turbo = await readJson<TurboConfig>('turbo.json')
  const rootEntries = readdirSync(REPO_ROOT)

  const scriptNames = pkg.scripts ? Object.keys(pkg.scripts) : []
  const scriptCount = countPackageScripts(pkg)
  const coverage = documentedScriptRatio(scriptNames, [...DOCUMENTED_SCRIPTS])
  const hookStatus = hookEnforcementStatus({
    hasLefthookConfig: fileExists('lefthook.yml'),
    hasLefthookDependency: Boolean(pkg.devDependencies?.lefthook),
  })
  const prettierCount = duplicateFormatConfigCount(rootEntries)
  const dangling = danglingTurboInputs(turbo, fileExists)

  const lines: string[] = []
  lines.push('# optimize-devx report')
  lines.push('')
  lines.push(`Root pnpm script count: ${scriptCount}`)
  lines.push(
    `Documented script coverage: ${coverage.documented}/${coverage.total} (${(coverage.ratio * 100).toFixed(1)}%)`,
  )
  lines.push(`Git-hook enforcement status: ${hookStatus}`)
  lines.push(`Prettier config files at repo root: ${prettierCount}`)
  if (dangling.length === 0) {
    lines.push('Dangling turbo.json inputs: none')
  } else {
    lines.push(`Dangling turbo.json inputs: ${dangling.length}`)
    for (const {task, input} of dangling) {
      lines.push(`  - ${task}: ${input}`)
    }
  }
  lines.push('')
  lines.push('This report is informational. The drift gate is')
  lines.push('test/unit/documentation/devx-docs.test.ts.')

  process.stdout.write(`${lines.join('\n')}\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`optimize-devx failed: ${message}\n`)
  process.exit(1)
})
