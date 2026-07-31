import {readFile} from 'node:fs/promises'
import {existsSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  countPackageScripts,
  danglingTurboInputs,
  duplicateFormatConfigCount,
} from '../../../src/experience/dev-experience.js'

const REPO_ROOT = process.cwd()

async function readRepoFile(relative: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relative), 'utf8')
}

// Permanent regression guard: none of these files may resurface the retired skill slug or
// its script/test file names. Kept explicit so the guard fails closed if a new file is
// added that should also be guarded — the reviewer must consciously widen the list.
const STALE_NAME_GUARDED_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/testing.md',
  'AGENTS.md',
  'squad.config.ts',
  'package.json',
] as const

const RETIRED_NAMES = ['optimize-devx', 'optimize:devx', 'devx-docs'] as const

// pnpm subcommands that are not package.json scripts. `install` is a pnpm built-in;
// `vitest` is a locally-installed bin executed through pnpm. Both may legitimately
// appear in prose next to real script names and must not fail the deterministic check.
const PNPM_BUILTIN_SUBCOMMANDS = new Set(['install', 'vitest'])

function extractPnpmScripts(source: string): ReadonlyArray<string> {
  // Matches backtick-quoted `pnpm <name>` where <name> is a script-like identifier.
  const regex = /`pnpm ([a-z][a-z0-9:-]*)`/g
  const found = new Set<string>()
  for (const match of source.matchAll(regex)) {
    const name = match[1]
    if (name !== undefined && name.length > 0) {
      found.add(name)
    }
  }
  return [...found]
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start === -1) return ''
  const after = source.slice(start + startMarker.length)
  const end = after.indexOf(endMarker)
  return end === -1 ? after : after.slice(0, end)
}

describe('developer-experience documentation drift', () => {
  // Scope note: this file guards contributor-facing prose and the five supporting DX
  // signals. It intentionally does NOT re-verify that `.github/skills/optimize-dx/SKILL.md`
  // matches `squad.config.ts` — `pnpm squad:check` (via `squad build --check`) already owns
  // that contract, and duplicating it here would double-book the failure mode.

  it('keeps the script count consistent across package.json, CONTRIBUTING.md, and the Theo persona rationale', async () => {
    const pkgRaw = await readRepoFile('package.json')
    const pkg = JSON.parse(pkgRaw) as {scripts?: Record<string, unknown>}
    const scriptCount = countPackageScripts(pkg)
    // Sanity: repository should not regress below a sensible surface.
    expect(scriptCount).toBeGreaterThanOrEqual(20)

    const contributing = await readRepoFile('CONTRIBUTING.md')
    expect(contributing).toContain(String(scriptCount))
    // Section must exist so the number is anchored to prose that names it.
    expect(contributing).toContain('Common commands')

    const personas = await readRepoFile('src/experience/personas.ts')
    // The Theo persona's commandDiscoverability rationale comment cites the real
    // measured count. Update that comment whenever the surface changes.
    expect(personas).toContain(`${scriptCount} root pnpm scripts`)
  })

  it('keeps exactly one Prettier configuration at the repo root', () => {
    const rootEntries = readdirSync(REPO_ROOT)
    expect(duplicateFormatConfigCount(rootEntries)).toBe(1)
  })

  it('leaves no dangling input path in turbo.json', async () => {
    const turboRaw = await readRepoFile('turbo.json')
    const turbo = JSON.parse(turboRaw) as {
      tasks: Record<string, {inputs?: readonly string[]}>
    }
    const findings = danglingTurboInputs(turbo, (relative) =>
      existsSync(path.join(REPO_ROOT, relative)),
    )
    expect(findings).toEqual([])
  })

  it('declares lefthook as a devDependency so the pre-commit and pre-push hooks are enforceable', async () => {
    const pkgRaw = await readRepoFile('package.json')
    const pkg = JSON.parse(pkgRaw) as {devDependencies?: Record<string, string>}
    expect(pkg.devDependencies).toBeDefined()
    expect(pkg.devDependencies?.lefthook).toBeDefined()
  })

  it('ships a lefthook.yml so hooks actually run pre-commit and pre-push commands', async () => {
    const yml = await readRepoFile('lefthook.yml')
    expect(yml).toContain('pre-commit:')
    expect(yml).toContain('pre-push:')
    expect(yml).toContain('secrets:scan')
  })

  it('never resurfaces the retired optimize-devx / optimize:devx / devx-docs names in developer-facing prose or config', async () => {
    for (const file of STALE_NAME_GUARDED_FILES) {
      const contents = await readRepoFile(file)
      for (const stale of RETIRED_NAMES) {
        expect(
          contents,
          `${file} must not contain the retired name ${JSON.stringify(stale)}`,
        ).not.toContain(stale)
      }
    }
  })

  it('names only real package.json scripts in the README quick-start section', async () => {
    const pkgRaw = await readRepoFile('package.json')
    const pkg = JSON.parse(pkgRaw) as {scripts?: Record<string, unknown>}
    const declared = new Set(Object.keys(pkg.scripts ?? {}))

    const readme = await readRepoFile('README.md')
    const quickStart = sliceBetween(readme, '## Contributor quick start', '## Migrate teams')
    expect(quickStart.length).toBeGreaterThan(0)

    const invoked = extractPnpmScripts(quickStart)
    expect(invoked.length).toBeGreaterThan(0)
    for (const name of invoked) {
      if (PNPM_BUILTIN_SUBCOMMANDS.has(name)) continue
      expect(
        declared.has(name),
        `README quick start names \`pnpm ${name}\`, but no such script exists in package.json`,
      ).toBe(true)
    }
  })

  it('names only real package.json scripts in the CONTRIBUTING common-commands table', async () => {
    const pkgRaw = await readRepoFile('package.json')
    const pkg = JSON.parse(pkgRaw) as {scripts?: Record<string, unknown>}
    const declared = new Set(Object.keys(pkg.scripts ?? {}))

    const contributing = await readRepoFile('CONTRIBUTING.md')
    const commonCommands = sliceBetween(contributing, '## Common commands', '## Git hooks')
    expect(commonCommands.length).toBeGreaterThan(0)

    const invoked = extractPnpmScripts(commonCommands)
    expect(invoked.length).toBeGreaterThan(0)
    for (const name of invoked) {
      if (PNPM_BUILTIN_SUBCOMMANDS.has(name)) continue
      expect(
        declared.has(name),
        `CONTRIBUTING common commands names \`pnpm ${name}\`, but no such script exists in package.json`,
      ).toBe(true)
    }
  })
})
