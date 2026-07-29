import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {decodeCheckpoint, decodeConfig, encodeCheckpoint} from '../../../src/effect/schemas.js'
import type {CheckpointState} from '../../../src/types/index.js'
import {CHECKPOINT_SCHEMA_VERSION} from '../../../src/types/index.js'

function validCheckpoint(): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    migrationConfig: {
      apply: false,
      prefix: '',
      suffix: '',
    },
    phase: 'fetch',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

describe('effect schemas', () => {
  it('rejects malformed config', async () => {
    await expect(
      Effect.runPromise(decodeConfig({adoPat: 42})),
    ).rejects.toThrow('Malformed config.json')
  })

  it('rejects malformed checkpoint', async () => {
    await expect(
      Effect.runPromise(decodeCheckpoint({runId: 'x'})),
    ).rejects.toThrow('Malformed checkpoint state')
  })

  it('encodes and decodes valid checkpoint', async () => {
    const checkpoint = validCheckpoint()
    const encoded = await Effect.runPromise(encodeCheckpoint(checkpoint))
    const decoded = await Effect.runPromise(decodeCheckpoint(encoded))
    expect(decoded.runId).toBe('run-1')
    expect(decoded.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION)
    expect(decoded.phase).toBe('fetch')
  })
})
