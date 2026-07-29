import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import type {TokenCredential} from '@azure/identity'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  AuthManager,
  ENTRA_APPLICATION_SCOPES,
  ENTRA_DELEGATED_SCOPES,
  interactiveScopesFor,
  normalizeAmbientTenantId,
} from '../../../src/auth/manager.js'

const directories: string[] = []
const ambientCredential: TokenCredential = {
  getToken: async () => ({token: 'ambient-token', expiresOnTimestamp: Date.now() + 60_000}),
}

async function temporaryConfig(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ado-gh-auth-'))
  directories.push(directory)
  return path.join(directory, 'config.json')
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})),
  )
})

describe('AuthManager', () => {
  it('prefers explicit tokens while retaining ambient Entra credentials', async () => {
    const createAzureCredential = vi.fn(async () => ambientCredential)
    const manager = new AuthManager({
      configPath: await temporaryConfig(),
      env: {
        ADO_PAT: 'ado-token',
        GH_TOKEN: 'github-token',
      },
      interactive: false,
      createAzureCredential,
    })

    const resolved = await manager.resolveCredentials()

    expect(resolved.ado).toEqual({
      kind: 'pat',
      token: 'ado-token',
      source: 'environment',
    })
    expect(resolved.githubToken).toBe('github-token')
    expect(resolved.githubSource).toBe('environment')
    expect(resolved.entraCredential).toBe(ambientCredential)
    expect(resolved.entraScopes).toEqual(ENTRA_APPLICATION_SCOPES)
    expect(createAzureCredential).toHaveBeenCalledWith(
      'organizations',
      '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
      false,
    )
  })

  it('uses application scopes for workload and service principal identities', async () => {
    const manager = new AuthManager({
      configPath: await temporaryConfig(),
      env: {
        AZURE_CLIENT_ID: 'client',
        AZURE_TENANT_ID: 'tenant',
        AZURE_CLIENT_SECRET: 'secret',
        GH_TOKEN: 'github-token',
      },
      interactive: false,
      createAzureCredential: async () => ambientCredential,
    })

    const resolved = await manager.resolveCredentials()

    expect(resolved.ado).toMatchObject({kind: 'entra', source: 'ambient'})
    expect(resolved.entraScopes).toEqual(ENTRA_APPLICATION_SCOPES)
  })

  it('keeps generic tenants out of developer CLI calls and translates interactive scopes', () => {
    expect(normalizeAmbientTenantId('organizations')).toBeUndefined()
    expect(normalizeAmbientTenantId('common')).toBeUndefined()
    expect(normalizeAmbientTenantId('consumers')).toBeUndefined()
    expect(normalizeAmbientTenantId('tenant-id')).toBe('tenant-id')
    expect(interactiveScopesFor(ENTRA_APPLICATION_SCOPES[0])).toEqual(
      ENTRA_DELEGATED_SCOPES,
    )
  })

  it('ignores blank token variables when a later GitHub token is available', async () => {
    const manager = new AuthManager({
      configPath: await temporaryConfig(),
      env: {
        GH_TOKEN: ' ',
        GITHUB_TOKEN: 'github-token',
      },
      interactive: false,
      createAzureCredential: async () => ambientCredential,
    })

    const resolved = await manager.resolveCredentials()

    expect(resolved.githubToken).toBe('github-token')
    expect(resolved.githubSource).toBe('environment')
  })

  it('removes legacy plaintext credentials while preserving non-secret settings', async () => {
    const configPath = await temporaryConfig()
    await writeFile(
      configPath,
      JSON.stringify({
        adoPat: 'ado-secret',
        githubPat: 'github-secret',
        entraClientSecret: 'entra-secret',
        entraClientId: 'client',
        entraClientTenantId: 'tenant',
      }),
      'utf8',
    )
    const warn = vi.fn()
    const manager = new AuthManager({configPath, warn})

    const config = await manager.loadConfig()
    const persisted = await readFile(configPath, 'utf8')

    expect(config).toEqual({
      entraClientId: 'client',
      entraClientTenantId: 'tenant',
    })
    expect(persisted).not.toContain('ado-secret')
    expect(persisted).not.toContain('github-secret')
    expect(persisted).not.toContain('entra-secret')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Removed legacy plaintext credentials'),
    )
  })

  it('fails fast without GitHub ambient auth when interaction is disabled', async () => {
    const manager = new AuthManager({
      configPath: await temporaryConfig(),
      env: {PATH: ''},
      interactive: false,
      createAzureCredential: async () => ambientCredential,
    })

    await expect(manager.resolveCredentials()).rejects.toThrow(
      'Set GH_TOKEN or GITHUB_TOKEN, or run gh auth login',
    )
  })
})
