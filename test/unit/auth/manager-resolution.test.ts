import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import type {TokenCredential} from '@azure/identity'
import {afterEach, describe, expect, it} from 'vitest'

import {
  AuthManager,
  CredentialResolutionError,
  ENTRA_APPLICATION_SCOPES,
  type Config,
  type ResolvedCredentials,
} from '../../../src/auth/manager.js'

/**
 * Credential-resolution coverage for `AuthManager`.
 *
 * `AuthManagerOptions` exposes seams for every external dependency — config path, environment,
 * interactivity, platform, Azure credential construction, GitHub credential resolution, and the
 * warning sink. That makes the whole resolution surface testable deterministically without ever
 * contacting Entra, the Azure CLI, `gh`, or a token broker, which is exactly what AGENTS.md
 * requires of a unit test.
 *
 * The invariants that matter here are security ones: which credential source wins, that a failure
 * in one provider is reported as that provider's typed error rather than a generic throw, and that
 * legacy plaintext secrets are removed from an on-disk config rather than silently retained.
 */

const directories: string[] = []

const ambientCredential: TokenCredential = {
  getToken: async () => ({token: 'ambient-token', expiresOnTimestamp: Date.now() + 60_000}),
}

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'a2g-auth-manager-'))
  directories.push(directory)
  return path.join(directory, 'config.json')
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})),
  )
})

interface ManagerHarness {
  readonly manager: AuthManager
  readonly configPath: string
  readonly warnings: string[]
  readonly azureCalls: Array<{tenantId: string; clientId: string; interactive: boolean}>
}

async function harness(
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly interactive?: boolean
    readonly github?: () => Promise<{
      token: string
      source: ResolvedCredentials['githubSource']
    }>
    readonly azure?: () => Promise<TokenCredential>
  } = {},
): Promise<ManagerHarness> {
  const configPath = await temporaryConfigPath()
  const warnings: string[] = []
  const azureCalls: Array<{tenantId: string; clientId: string; interactive: boolean}> = []
  const manager = new AuthManager({
    configPath,
    env: options.env ?? {},
    interactive: options.interactive ?? false,
    platform: 'linux',
    warn: (message) => warnings.push(message),
    createAzureCredential: async (tenantId, clientId, interactive) => {
      azureCalls.push({tenantId, clientId, interactive})
      return options.azure ? options.azure() : ambientCredential
    },
    resolveGitHubCredential:
      options.github ?? (async () => ({token: 'gh-token', source: 'environment' as const})),
  })
  return {manager, configPath, warnings, azureCalls}
}

describe('AuthManager config persistence', () => {
  it('returns an empty config when no file exists', async () => {
    const {manager} = await harness()
    await expect(manager.loadConfig()).resolves.toEqual({})
  })

  it('round-trips the three supported config keys', async () => {
    const {manager} = await harness()
    const config: Config = {
      entraClientId: 'client-1',
      entraClientTenantId: 'tenant-1',
      githubClientId: 'gh-client-1',
    }
    await manager.saveConfig(config)
    await expect(manager.loadConfig()).resolves.toEqual(config)
  })

  it('ignores unknown and non-string keys rather than persisting them', async () => {
    const {manager, configPath} = await harness()
    await writeFile(
      configPath,
      JSON.stringify({entraClientId: 'client-1', entraClientTenantId: 42, unexpected: 'value'}),
      'utf8',
    )
    await expect(manager.loadConfig()).resolves.toEqual({entraClientId: 'client-1'})
  })

  it('rejects a config file that is not a JSON object', async () => {
    const {manager, configPath} = await harness()
    await writeFile(configPath, JSON.stringify(['not', 'an', 'object']), 'utf8')
    await expect(manager.loadConfig()).rejects.toThrow(/must be a JSON object/)
  })

  it('rejects a config file that is not valid JSON at all', async () => {
    const {manager, configPath} = await harness()
    await writeFile(configPath, '{ this is not json', 'utf8')
    await expect(manager.loadConfig()).rejects.toThrow()
  })

  it.each(['adoPat', 'githubPat', 'entraClientSecret'])(
    'strips a legacy plaintext %s from disk and warns',
    async (legacyKey) => {
      const {manager, configPath, warnings} = await harness()
      await writeFile(
        configPath,
        JSON.stringify({entraClientId: 'client-1', [legacyKey]: 'a-plaintext-secret-value'}),
        'utf8',
      )

      const config = await manager.loadConfig()

      expect(config).toEqual({entraClientId: 'client-1'})
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('Removed legacy plaintext credentials')
      // The rewrite must actually happen on disk. A warning without a rewrite would leave the
      // secret sitting in the file while telling the operator it was removed.
      const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      expect(onDisk).toEqual({entraClientId: 'client-1'})
      expect(legacyKey in onDisk).toBe(false)
    },
  )

  it('writes the config with owner-only permissions', async () => {
    const {manager, configPath} = await harness()
    await manager.saveConfig({entraClientId: 'client-1'})
    const stats = await stat(configPath)
    // Windows does not model POSIX permission bits, so assert only where they are meaningful.
    if (process.platform !== 'win32') {
      expect(stats.mode & 0o777).toBe(0o600)
    }
    expect(stats.isFile()).toBe(true)
  })
})

describe('AuthManager credential resolution', () => {
  it('prefers an ADO PAT from the environment', async () => {
    const {manager} = await harness({env: {ADO_PAT: 'pat-value'}})
    const resolved = await manager.resolveCredentials()
    expect(resolved.ado).toEqual({kind: 'pat', token: 'pat-value', source: 'environment'})
  })

  it('trims a padded ADO PAT', async () => {
    const {manager} = await harness({env: {ADO_PAT: '  pat-value  '}})
    const resolved = await manager.resolveCredentials()
    expect(resolved.ado).toEqual({kind: 'pat', token: 'pat-value', source: 'environment'})
  })

  it('falls back to an ambient Entra credential when no PAT is set', async () => {
    const {manager} = await harness()
    const resolved = await manager.resolveCredentials()
    expect(resolved.ado.kind).toBe('entra')
    expect(resolved.ado).toMatchObject({source: 'ambient'})
  })

  it('treats a whitespace-only ADO PAT as absent', async () => {
    // A blank environment variable must not be mistaken for a credential; falling through to the
    // ambient identity is correct, silently authenticating with an empty PAT is not.
    const {manager} = await harness({env: {ADO_PAT: '   '}})
    const resolved = await manager.resolveCredentials()
    expect(resolved.ado.kind).toBe('entra')
  })

  it('reports the resolved GitHub token and its source', async () => {
    const {manager} = await harness({
      github: async () => ({token: 'cli-token', source: 'github-cli' as const}),
    })
    const resolved = await manager.resolveCredentials()
    expect(resolved.githubToken).toBe('cli-token')
    expect(resolved.githubSource).toBe('github-cli')
  })

  it('always requests the application Graph scopes', async () => {
    const {manager} = await harness()
    const resolved = await manager.resolveCredentials()
    expect(resolved.entraScopes).toEqual(ENTRA_APPLICATION_SCOPES)
  })

  it('wraps a GitHub resolution failure in a typed provider error', async () => {
    const cause = new Error('gh auth login has not been run')
    const {manager} = await harness({
      github: async () => {
        throw cause
      },
    })

    const error = await manager.resolveCredentials().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CredentialResolutionError)
    expect((error as CredentialResolutionError).provider).toBe('github')
    expect((error as CredentialResolutionError).cause).toBe(cause)
    expect((error as CredentialResolutionError).message).toContain('GH_TOKEN')
  })

  it('wraps an Azure resolution failure in a typed provider error', async () => {
    const cause = new Error('no ambient identity')
    const {manager} = await harness({
      azure: async () => {
        throw cause
      },
    })

    const error = await manager.resolveAzureCredential().catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(CredentialResolutionError)
    expect((error as CredentialResolutionError).provider).toBe('entra')
    expect((error as CredentialResolutionError).cause).toBe(cause)
  })
})

describe('AuthManager tenant and client resolution', () => {
  it('defaults to the organizations tenant when nothing is configured', async () => {
    const {manager, azureCalls} = await harness()
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.tenantId).toBe('organizations')
  })

  it('prefers AZURE_TENANT_ID over ENTRA_TENANT_ID and over the config file', async () => {
    const {manager, azureCalls} = await harness({
      env: {AZURE_TENANT_ID: 'azure-tenant', ENTRA_TENANT_ID: 'entra-tenant'},
    })
    await manager.saveConfig({entraClientTenantId: 'config-tenant'})
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.tenantId).toBe('azure-tenant')
  })

  it('prefers ENTRA_TENANT_ID over the config file', async () => {
    const {manager, azureCalls} = await harness({env: {ENTRA_TENANT_ID: 'entra-tenant'}})
    await manager.saveConfig({entraClientTenantId: 'config-tenant'})
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.tenantId).toBe('entra-tenant')
  })

  it('falls back to the configured tenant when no environment variable is set', async () => {
    const {manager, azureCalls} = await harness()
    await manager.saveConfig({entraClientTenantId: 'config-tenant'})
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.tenantId).toBe('config-tenant')
  })

  it('ignores a blank tenant environment variable', async () => {
    const {manager, azureCalls} = await harness({env: {AZURE_TENANT_ID: '   '}})
    await manager.saveConfig({entraClientTenantId: 'config-tenant'})
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.tenantId).toBe('config-tenant')
  })

  it('prefers ENTRA_CLIENT_ID over ENTRA_PUBLIC_CLIENT_ID and over the config file', async () => {
    const {manager, azureCalls} = await harness({
      env: {ENTRA_CLIENT_ID: 'explicit-client', ENTRA_PUBLIC_CLIENT_ID: 'public-client'},
    })
    await manager.saveConfig({entraClientId: 'config-client'})
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.clientId).toBe('explicit-client')
  })

  it('falls back to the configured client id', async () => {
    const {manager, azureCalls} = await harness()
    await manager.saveConfig({entraClientId: 'config-client'})
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.clientId).toBe('config-client')
  })

  it('uses a built-in public client id when none is configured', async () => {
    const {manager, azureCalls} = await harness()
    await manager.resolveAzureCredential()
    expect(azureCalls[0]?.clientId).toBeTruthy()
  })

  it('propagates the interactive flag to credential construction', async () => {
    const interactiveHarness = await harness({interactive: true})
    await interactiveHarness.manager.resolveAzureCredential()
    expect(interactiveHarness.azureCalls[0]?.interactive).toBe(true)

    const headlessHarness = await harness({interactive: false})
    await headlessHarness.manager.resolveAzureCredential()
    expect(headlessHarness.azureCalls[0]?.interactive).toBe(false)
  })
})
