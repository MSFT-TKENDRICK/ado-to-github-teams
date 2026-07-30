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

describe('developer-experience documentation drift', () => {
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
})
