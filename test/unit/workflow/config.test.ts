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

  it('rejects remote targets without explicit opt-in', () => {
    expect(() =>
      resolveWorldRuntimeConfig({
        WORKFLOW_TARGET_WORLD: '@example/remote-world',
      }),
    ).toThrow(
      'Remote Workflow World targets require WORKFLOW_ALLOW_REMOTE_TARGET=true.',
    )
  })

  it('accepts a remote target only with explicit opt-in', () => {
    expect(
      resolveWorldRuntimeConfig({
        WORKFLOW_TARGET_WORLD: '@example/remote-world',
        WORKFLOW_ALLOW_REMOTE_TARGET: 'true',
      }),
    ).toEqual({mode: 'remote', target: '@example/remote-world'})
  })

  it('rejects invalid queue concurrency', () => {
    expect(() =>
      resolveWorldRuntimeConfig({
        WORKFLOW_NATS_CONCURRENCY: '0',
      }),
    ).toThrow('Expected a positive integer')
  })
})
