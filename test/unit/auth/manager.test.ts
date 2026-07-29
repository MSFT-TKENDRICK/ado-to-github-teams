import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import type {Configuration, DeviceCodeRequest} from '@azure/msal-node'
import {describe, expect, it} from 'vitest'
import {AuthManager} from '../../../src/auth/manager.js'

describe('AuthManager', () => {
  it('resolves and persists first-run ADO device-flow credentials as Bearer tokens', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'ado-auth-'))
    const previousAdoPat = process.env.ADO_PAT
    const previousTokenType = process.env.ADO_TOKEN_TYPE
    const previousClientId = process.env.ENTRA_PUBLIC_CLIENT_ID
    const previousTenantId = process.env.ADO_TENANT_ID
    let capturedConfiguration: Configuration | undefined
    let capturedRequest: DeviceCodeRequest | undefined

    try {
      delete process.env.ADO_PAT
      delete process.env.ADO_TOKEN_TYPE
      process.env.ENTRA_PUBLIC_CLIENT_ID = 'test-public-client'
      process.env.ADO_TENANT_ID = 'test-tenant'

      const manager = new AuthManager(path.join(configDir, 'config.json'), (configuration) => {
        capturedConfiguration = configuration
        return {
          acquireTokenByDeviceCode: async (request) => {
            capturedRequest = request
            return {accessToken: 'opaque-access-token'}
          },
        }
      })

      await manager.saveConfig({
        githubPat: 'github-token',
        entraClientId: 'entra-client',
        entraClientSecret: 'entra-secret',
        entraClientTenantId: 'entra-tenant',
      })
      const resolved = await manager.resolveCredentials()

      expect(resolved).toMatchObject({
        adoPat: 'opaque-access-token',
        adoTokenType: 'bearer',
      })
      expect(capturedConfiguration?.auth).toMatchObject({
        clientId: 'test-public-client',
        authority: 'https://login.microsoftonline.com/test-tenant',
      })
      expect(capturedRequest?.scopes).toEqual([
        '499b84ac-1321-427f-aa17-267ca6975798/user_impersonation',
      ])
      await expect(manager.loadConfig()).resolves.toMatchObject({
        adoPat: 'opaque-access-token',
        adoTokenType: 'bearer',
      })
    } finally {
      if (previousAdoPat === undefined) {
        delete process.env.ADO_PAT
      } else {
        process.env.ADO_PAT = previousAdoPat
      }
      if (previousTokenType === undefined) {
        delete process.env.ADO_TOKEN_TYPE
      } else {
        process.env.ADO_TOKEN_TYPE = previousTokenType
      }
      if (previousClientId === undefined) {
        delete process.env.ENTRA_PUBLIC_CLIENT_ID
      } else {
        process.env.ENTRA_PUBLIC_CLIENT_ID = previousClientId
      }
      if (previousTenantId === undefined) {
        delete process.env.ADO_TENANT_ID
      } else {
        process.env.ADO_TENANT_ID = previousTenantId
      }
      await rm(configDir, {recursive: true, force: true})
    }
  })

  it('rejects legacy ADO credentials whose authentication scheme is ambiguous', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'ado-auth-'))
    const previousAdoPat = process.env.ADO_PAT

    try {
      delete process.env.ADO_PAT
      const manager = new AuthManager(path.join(configDir, 'config.json'))
      await manager.saveConfig({
        adoPat: 'legacy-token',
        githubPat: 'github-token',
        entraClientId: 'entra-client',
        entraClientSecret: 'entra-secret',
        entraClientTenantId: 'entra-tenant',
      })

      await expect(manager.resolveCredentials()).rejects.toThrow(
        'predates explicit token typing',
      )
    } finally {
      if (previousAdoPat === undefined) {
        delete process.env.ADO_PAT
      } else {
        process.env.ADO_PAT = previousAdoPat
      }
      await rm(configDir, {recursive: true, force: true})
    }
  })

  it('rejects unsupported persisted ADO token types', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'ado-auth-'))
    const configPath = path.join(configDir, 'config.json')
    const previousAdoPat = process.env.ADO_PAT

    try {
      delete process.env.ADO_PAT
      await writeFile(
        configPath,
        JSON.stringify({adoPat: 'token', adoTokenType: 'jwt'}),
        'utf8',
      )

      await expect(new AuthManager(configPath).resolveCredentials()).rejects.toThrow(
        'unsupported token type',
      )
    } finally {
      if (previousAdoPat === undefined) {
        delete process.env.ADO_PAT
      } else {
        process.env.ADO_PAT = previousAdoPat
      }
      await rm(configDir, {recursive: true, force: true})
    }
  })
})
