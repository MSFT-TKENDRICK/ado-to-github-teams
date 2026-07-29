import {describe, expect, it} from 'vitest'
import {Effect, Layer} from 'effect'
import {openMigrationSession} from '../../../../src/effect/migration/lifecycle.js'
import {CheckpointStoreTag, type CheckpointStore} from '../../../../src/effect/services.js'
import type {CheckpointState} from '../../../../src/types/index.js'

describe('openMigrationSession', () => {
  it('owns checkpoint creation, flushing, and completion', async () => {
    const saves: CheckpointState[] = []
    const deletes: string[] = []
    const checkpoints: CheckpointStore = {
      save: (state) =>
        Effect.sync(() => {
          saves.push(structuredClone(state))
        }),
      load: () => Effect.succeed(null),
      latest: Effect.succeed(null),
      list: Effect.succeed([]),
      delete: (runId) =>
        Effect.sync(() => {
          deletes.push(runId)
        }),
    }
    const layer = Layer.succeed(CheckpointStoreTag, checkpoints)

    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* openMigrationSession(
          {
            adoOrg: 'https://dev.azure.com/contoso',
            adoProject: 'Engineering',
            githubOrg: 'contoso',
            apply: false,
            concurrency: 2,
          },
          'run-1',
          '2026-01-01T00:00:00.000Z',
        )
        const state = yield* session.store.get
        yield* session.store.save({...state, phase: 'map'})
        yield* session.flush
        yield* session.complete
        yield* session.flush
      }).pipe(Effect.provide(layer)),
    )

    expect(saves.map((state) => state.phase)).toEqual(['fetch', 'map'])
    expect(deletes).toEqual(['run-1'])
  })

  it('reopens the latest compatible session without a run id', async () => {
    const resumed = {
      schemaVersion: 1,
      runId: 'run-latest',
      timestamp: '2026-01-02T00:00:00.000Z',
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Engineering',
      githubOrg: 'contoso',
      migrationConfig: {apply: false, prefix: '', suffix: ''},
      phase: 'map' as const,
      completedTeams: [],
      completedMemberPairs: [],
      pendingTeams: [],
      mappings: [],
      edgeCases: [],
      skippedItems: [],
      failureLog: [],
      approvalHistory: [],
    }
    const checkpoints: CheckpointStore = {
      save: () => Effect.void,
      load: () => Effect.succeed(null),
      latest: Effect.succeed(resumed),
      list: Effect.succeed([]),
      delete: () => Effect.void,
    }

    const state = await Effect.runPromise(
      openMigrationSession(
        {
          adoOrg: resumed.adoOrg,
          adoProject: resumed.adoProject,
          githubOrg: resumed.githubOrg,
          apply: false,
          concurrency: 2,
        },
        'new-run',
        '2026-01-03T00:00:00.000Z',
      ).pipe(
        Effect.flatMap((session) => session.store.get),
        Effect.provide(Layer.succeed(CheckpointStoreTag, checkpoints)),
      ),
    )

    expect(state.runId).toBe('run-latest')
    expect(state.phase).toBe('map')
  })

  it('can disable automatic resume for isolated runtimes', async () => {
    const saves: CheckpointState[] = []
    const checkpoints: CheckpointStore = {
      save: (state) =>
        Effect.sync(() => {
          saves.push(structuredClone(state))
        }),
      load: () => Effect.succeed(null),
      latest: Effect.succeed({
        schemaVersion: 1,
        runId: 'stale-sandbox-run',
        timestamp: '2026-01-02T00:00:00.000Z',
        adoOrg: 'sandbox',
        adoProject: 'sandbox',
        githubOrg: 'sandbox',
        migrationConfig: {apply: false, prefix: '', suffix: ''},
        phase: 'map',
        completedTeams: [],
        completedMemberPairs: [],
        pendingTeams: [],
        mappings: [],
        edgeCases: [],
        skippedItems: [],
        failureLog: [],
        approvalHistory: [],
      }),
      list: Effect.succeed([]),
      delete: () => Effect.void,
    }

    const state = await Effect.runPromise(
      openMigrationSession(
        {
          adoOrg: 'sandbox',
          adoProject: 'sandbox',
          githubOrg: 'sandbox',
          apply: false,
          concurrency: 1,
          autoResume: false,
        },
        'fresh-sandbox-run',
        '2026-01-03T00:00:00.000Z',
      ).pipe(
        Effect.flatMap((session) => session.store.get),
        Effect.provide(Layer.succeed(CheckpointStoreTag, checkpoints)),
      ),
    )

    expect(state.runId).toBe('fresh-sandbox-run')
    expect(saves).toHaveLength(1)
  })
})
