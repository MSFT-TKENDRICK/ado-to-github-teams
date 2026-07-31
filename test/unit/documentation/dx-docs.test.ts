import {readFile} from 'node:fs/promises'
import {existsSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  countPackageScripts,
  danglingTurboInputs,
  duplicateFormatConfigCount,
  extractPnpmScriptReferences,
  INTENTIONAL_INTERNAL_SCRIPTS,
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
  return extractPnpmScriptReferences([source])
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

  it('documents every root script or explicitly classifies it as an internal aggregate step', async () => {
    const pkgRaw = await readRepoFile('package.json')
    const pkg = JSON.parse(pkgRaw) as {scripts?: Record<string, unknown>}
    const docs = (
      await Promise.all([
        readRepoFile('README.md'),
        readRepoFile('CONTRIBUTING.md'),
        readRepoFile('docs/testing.md'),
      ])
    ).join('\n')
    const documented = new Set(extractPnpmScriptReferences([docs]))
    const internal = new Set<string>(INTENTIONAL_INTERNAL_SCRIPTS)

    for (const script of Object.keys(pkg.scripts ?? {})) {
      expect(
        documented.has(script) || internal.has(script),
        `package.json script \`pnpm ${script}\` must be documented or intentionally allowlisted`,
      ).toBe(true)
    }
  })

  it('keeps public package and executable anchors aligned with consumer documentation', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as {
      name: string
      bin: Record<string, string>
    }
    const consumerDocs = `${await readRepoFile('README.md')}\n${await readRepoFile(
      'docs/using-the-cli.md',
    )}`

    expect(pkg.name).toBe('@msft-tkendrick/a2g')
    expect(pkg.bin).toMatchObject({
      a2g: './bin/run.js',
      'ado-to-github-teams': './bin/run.js',
    })
    expect(consumerDocs).toContain('npm install --global @msft-tkendrick/a2g@preview')
    expect(consumerDocs).toContain('a2g --help')
  })

  it('limits consumer installation to one install command and one verification command', async () => {
    const usingTheCli = await readRepoFile('docs/using-the-cli.md')
    const readme = await readRepoFile('README.md')
    const installSection = sliceBetween(usingTheCli, '## Install', '## Install from source')
    const readmeInstallSection = sliceBetween(
      readme,
      '## Try it safely',
      '### Optional Azure world',
    )
    const readCommands = (section: string): string[] | undefined =>
      section
        .match(/```bash\r?\n([\s\S]*?)```/)?.[1]
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    const consumerCommands = ['npm install --global @msft-tkendrick/a2g@preview', 'a2g --help']

    expect(readCommands(installSection)).toEqual(consumerCommands)
    expect(readCommands(readmeInstallSection)).toEqual(consumerCommands)
    expect(installSection).toContain('the release is blocked')
    expect(installSection).toContain('must not be presented as consumer installation')
  })

  it('bootstraps pinned pnpm without assuming supported Node releases bundle Corepack', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json')) as {
      packageManager: string
      engines: {node: string}
    }
    expect(pkg.packageManager).toBe('pnpm@10.34.5')
    expect(pkg.engines.node).toBe('>=22.18.0 <26')
    const bootstrapCommand = `npm install --global ${pkg.packageManager}`

    for (const file of [
      'README.md',
      'CONTRIBUTING.md',
      'docs/using-the-cli.md',
      'skills/ado-to-github-teams/references/installation.md',
    ] as const) {
      const contents = await readRepoFile(file)
      expect(contents, `${file} must bootstrap the pinned pnpm version`).toContain(bootstrapCommand)
    }

    for (const file of [
      'README.md',
      'CONTRIBUTING.md',
      'docs/using-the-cli.md',
      'skills/ado-to-github-teams/references/installation.md',
      'skills/optimize-dx/SKILL.md',
      'skills/optimize-dx/references/areas/INDEX.md',
      'skills/optimize-dx/references/areas/devcontainers.md',
      'skills/optimize-dx/references/areas/local-environment-and-onboarding.md',
      'skills/optimize-dx/references/areas/packages-and-dependencies.md',
    ] as const) {
      const contents = await readRepoFile(file)
      expect(contents, `${file} must not assume Corepack is installed`).not.toContain(
        'corepack enable',
      )
    }
  })

  it('ships an area catalog INDEX naming every required DevEx area', async () => {
    const indexRelative = 'skills/optimize-dx/references/areas/INDEX.md'
    expect(
      existsSync(path.join(REPO_ROOT, indexRelative)),
      `${indexRelative} must exist to route DX cycles through the area catalog`,
    ).toBe(true)
    const index = await readRepoFile(indexRelative)
    // The catalog must literally name every one of the fifteen concerns Theo owns.
    // Each entry lists synonyms/alternative wordings — the INDEX must contain at least
    // one form of each concern so a contributor searching for it finds a hit.
    const REQUIRED_AREA_CONCERNS: ReadonlyArray<ReadonlyArray<string>> = [
      ['documentation'],
      ['repository-structure-and-config', 'repository structure', 'repo structure'],
      ['local-environment-and-onboarding', 'local environment', 'onboarding'],
      ['file-folder-hierarchy', 'file/folder hierarchy', 'folder hierarchy'],
      ['projects-and-workspaces', 'projects/workspaces', 'workspaces'],
      ['packages-and-dependencies', 'packages/dependencies', 'dependencies'],
      ['developer-tools', 'developer tools', 'build/test/lint'],
      ['git-hooks', 'git hooks'],
      ['git-github-cli-and-extensions', 'github cli', 'gh'],
      ['devcontainers'],
      ['dotfiles'],
      ['cli-invocation-and-naming', 'cli invocation'],
      ['packaging-and-distribution', 'packaging and distribution'],
      ['release-and-versioning', 'release and versioning'],
      ['build-package-and-deploy', 'build, package, and deploy'],
    ]
    const lower = index.toLowerCase()
    for (const synonyms of REQUIRED_AREA_CONCERNS) {
      const matched = synonyms.some((synonym) => lower.includes(synonym.toLowerCase()))
      expect(matched, `area catalog INDEX must name one of ${JSON.stringify(synonyms)}`).toBe(true)
    }
  })

  it('backs every area link in the catalog INDEX with a real file on disk', async () => {
    const indexRelative = 'skills/optimize-dx/references/areas/INDEX.md'
    const index = await readRepoFile(indexRelative)
    // Match markdown links to sibling area files ([label](area-name.md)) — sibling relative
    // paths only, not links to '..' references or external URLs.
    const linkRegex = /\]\(([a-z][a-z0-9-]*\.md)\)/g
    const areaFiles = new Set<string>()
    for (const match of index.matchAll(linkRegex)) {
      const filename = match[1]
      if (filename !== undefined) areaFiles.add(filename)
    }
    expect(areaFiles.size).toBeGreaterThanOrEqual(15)
    for (const file of areaFiles) {
      const relative = `skills/optimize-dx/references/areas/${file}`
      expect(
        existsSync(path.join(REPO_ROOT, relative)),
        `${indexRelative} links to ${relative}, but the file does not exist`,
      ).toBe(true)
    }
  })

  it('documents pnpm optimize:dx --iterations consistently across README, CONTRIBUTING, SKILL, and docs/testing', async () => {
    const pkgRaw = await readRepoFile('package.json')
    const pkg = JSON.parse(pkgRaw) as {scripts?: Record<string, string>}
    // The example commands must reference a real, declared script.
    expect(pkg.scripts?.['optimize:dx']).toBeDefined()

    const readme = await readRepoFile('README.md')
    const contributing = await readRepoFile('CONTRIBUTING.md')
    const skill = await readRepoFile('skills/optimize-dx/SKILL.md')
    const testing = await readRepoFile('docs/testing.md')

    // Every one of these files must show BOTH the bare default form and an explicit
    // --iterations override, so contributors reading any single surface see the same
    // executable contract.
    for (const [label, contents] of [
      ['README.md', readme],
      ['CONTRIBUTING.md', contributing],
      ['skills/optimize-dx/SKILL.md', skill],
      ['docs/testing.md', testing],
    ] as const) {
      expect(
        contents.includes('pnpm optimize:dx'),
        `${label} must show the bare \`pnpm optimize:dx\` command`,
      ).toBe(true)
      expect(
        /pnpm optimize:dx[^\n]*--iterations/.test(contents),
        `${label} must show a \`pnpm optimize:dx -- --iterations <n>\` override example`,
      ).toBe(true)
    }
  })

  it('authors a distinct, non-empty write-ahead prediction for all fifteen DX areas', async () => {
    // Doc drift guard: the workflow doc claims the write-ahead cycle authors persona-authentic
    // predictions for every area. This test enforces the claim by importing
    // the same catalog the runnable driver uses and counting distinct, non-blank predictions.
    const {DX_AREA_CATALOG} = await import('../../../skills/optimize-dx/scripts/optimize-dx.js')
    expect(DX_AREA_CATALOG).toHaveLength(15)
    const predictions = DX_AREA_CATALOG.map((area) => area.expectedObservation.trim())
    for (const prediction of predictions) {
      expect(prediction.length).toBeGreaterThan(60)
    }
    expect(new Set(predictions).size).toBe(15)
  })

  it('names the write-ahead bus artifact path in workflow and qualitative-evidence references', async () => {
    // The two references the SKILL.md points at MUST mention the bus so a contributor who follows
    // the routing does not need to reverse-engineer where evidence lands. Drift here means prose
    // and code have separated.
    const workflow = await readRepoFile('skills/optimize-dx/references/workflow.md')
    const qualitative = await readRepoFile('skills/optimize-dx/references/qualitative-evidence.md')
    for (const [label, contents] of [
      ['workflow.md', workflow],
      ['qualitative-evidence.md', qualitative],
    ] as const) {
      expect(
        contents.toLowerCase().includes('write-ahead'),
        `${label} must reference the write-ahead persona protocol`,
      ).toBe(true)
    }
    // qualitative-evidence.md MUST call out bus-success ≠ DX-success explicitly.
    expect(qualitative.toLowerCase()).toMatch(/bus.*(success|append).*(?:not|≠|is not).*dx/i)
  })
})
