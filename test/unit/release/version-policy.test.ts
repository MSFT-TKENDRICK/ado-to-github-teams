import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('preview release policy', () => {
  it('keeps every published surface on the same plain pre-1.0 version', () => {
    const root = readJson('package.json') as {version: string}
    const cli = readJson('apps/cli/package.json') as {version: string}
    const plugin = readJson('plugin.json') as {version: string}
    const marketplace = readJson('.github/plugin/marketplace.json') as {
      metadata: {version: string}
      plugins: Array<{version: string}>
    }
    const manifest = readJson('.release-please-manifest.json') as Record<string, string>
    const versions = [
      root.version,
      cli.version,
      plugin.version,
      marketplace.metadata.version,
      marketplace.plugins[0]?.version,
      manifest['.'],
    ]

    expect(new Set(versions)).toEqual(new Set([root.version]))
    expect(root.version).toMatch(/^0\.\d+\.\d+$/)
  })

  it('publishes the preview channel with provenance and GitHub prerelease classification', () => {
    const config = readJson('release-please-config.json') as {
      packages: Record<string, Record<string, unknown>>
    }
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const root = readJson('package.json') as {
      name: string
      publishConfig: {access: string}
    }
    const rootRelease = config.packages['.']

    expect(root.name).toBe('@msft-tkendrick/a2g')
    expect(root.publishConfig.access).toBe('public')
    expect(rootRelease?.['prerelease']).toBe(true)
    expect(rootRelease).not.toHaveProperty('prerelease-type')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('--tag preview --provenance')
    expect(workflow).toContain('node scripts/validate-release-versions.mjs')
    expect(workflow).toContain('Verify published preview as a clean consumer')
    expect(workflow).toContain('npm view "@msft-tkendrick/a2g@preview" version')
    expect(workflow).toContain(`resolved_version" == "$package_version`)
    expect(workflow).toContain(
      'npm_config_prefix="$smoke_dir" npm install --global "@msft-tkendrick/a2g@${package_version}"',
    )
    expect(workflow).toContain('"$smoke_dir/bin/a2g" --help')
  })
})
