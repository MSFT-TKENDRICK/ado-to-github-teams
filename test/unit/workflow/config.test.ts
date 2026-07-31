import {describe, expect, it} from 'vitest'
import {resolveWorldRuntimeConfig} from '../../../src/workflow/config.js'

describe('workflow World configuration', () => {
  it('defaults to local SQLite and NATS targets', () => {
    const config = resolveWorldRuntimeConfig({})

    expect(config.mode).toBe('local')
    if (config.mode === 'local') {
      expect(config.sqlitePath).toMatch(/workflow\.db$/)
      expect(config.natsUrls).toEqual(['nats://127.0.0.1:4222'])
      expect(config.baseUrl).toBe('http://127.0.0.1:7331')
    }
  })

  it('rejects non-Azure deployment targets', () => {
    expect(() =>
      resolveWorldRuntimeConfig({
        WORKFLOW_TARGET_WORLD: '@example/remote-world',
      }),
    ).toThrow('WORKFLOW_TARGET_WORLD must be local or azure.')
  })

  it('decodes the Azure Durable Functions target', () => {
    expect(
      resolveWorldRuntimeConfig({
        WORKFLOW_TARGET_WORLD: 'azure',
        WORKFLOW_BASE_URL: 'https://a2g-worker.azurecontainerapps.io',
        AZURE_WORLD_DATABASE_URL: 'libsql://a2g.internal.azurecontainerapps.io',
        AZURE_WORLD_DATABASE_AUTH_TOKEN: 'database-auth-token',
        AZURE_DURABLE_STARTER_URL:
          'https://a2g-functions.azurewebsites.net/api/workflow-world/queue',
        A2G_DEPLOYMENT_ID: 'deployment-42',
      }),
    ).toEqual({
      mode: 'azure',
      databaseUrl: 'libsql://a2g.internal.azurecontainerapps.io',
      databaseAuthToken: 'database-auth-token',
      baseUrl: 'https://a2g-worker.azurecontainerapps.io',
      starterUrl: 'https://a2g-functions.azurewebsites.net/api/workflow-world/queue',
      deploymentId: 'deployment-42',
    })
  })

  it('rejects incomplete Azure Durable Functions configuration', () => {
    expect(() =>
      resolveWorldRuntimeConfig({
        WORKFLOW_TARGET_WORLD: 'azure',
      }),
    ).toThrow('Invalid workflow World configuration')
  })

  it('rejects process-local storage for an Azure World', () => {
    expect(() =>
      resolveWorldRuntimeConfig({
        WORKFLOW_TARGET_WORLD: 'azure',
        WORKFLOW_BASE_URL: 'https://a2g-worker.azurecontainerapps.io',
        AZURE_WORLD_DATABASE_URL: 'file:/mnt/a2g/workflow.db',
        AZURE_WORLD_DATABASE_AUTH_TOKEN: 'database-auth-token',
        AZURE_DURABLE_STARTER_URL:
          'https://a2g-functions.azurewebsites.net/api/workflow-world/queue',
        A2G_DEPLOYMENT_ID: 'deployment-42',
      }),
    ).toThrow('AZURE_WORLD_DATABASE_URL must use http: or https: or libsql: or wss:')
  })

  it('rejects invalid queue concurrency', () => {
    expect(() =>
      resolveWorldRuntimeConfig({
        WORKFLOW_NATS_CONCURRENCY: '0',
      }),
    ).toThrow('Expected a positive integer')
  })
})
