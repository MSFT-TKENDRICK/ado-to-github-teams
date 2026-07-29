import {describe, expect, it} from 'vitest'
import {Effect, Layer} from 'effect'
import {openMigrationSession} from '../../../../src/effect/migration/lifecycle.js'
import {
  CheckpointStoreTag,
  type CheckpointStore,
} from '../../../../src/effect/services.js'
import type {CheckpointState} from '../../../../src/types/index.js'
import {checkpointState} from './test-state.js'

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

    expect(saves.map((state) => state.phase)).toEqual(['fetch', 'map', 'map'])
    expect(deletes).toEqual(['run-1'])
  })

  it('rejects resume when the topology content digest changes', async () => {
    const loaded = checkpointState({
      migrationConfig: {
        apply: true,
        prefix: '',
        suffix: '',
        topologyDigest: 'reviewed-digest',
      },
    })
    const checkpoints: CheckpointStore = {
      save: () => Effect.void,
      load: () => Effect.succeed(loaded),
      list: Effect.succeed([]),
      delete: () => Effect.void,
    }
    const result = await Effect.runPromise(
      Effect.either(
        openMigrationSession(
          {
            adoOrg: loaded.adoOrg,
            adoProject: loaded.adoProject,
            githubOrg: loaded.githubOrg,
            apply: true,
            concurrency: 1,
            resume: loaded.runId,
            topology: {
              config: {
                version: 1,
                organizationalUnit: {name: 'Engineering'},
                repositories: [
                  {
                    repository: 'api',
                    teamName: 'API Contributors',
                    sourceAdoTeams: ['Contributors'],
                    role: 'write',
                  },
                ],
              },
              digest: 'changed-digest',
              sourcePath: 'topology.yaml',
            },
          },
          'unused',
          '2026-01-01T00:00:00.000Z',
        ).pipe(Effect.provide(Layer.succeed(CheckpointStoreTag, checkpoints))),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('topologyDigest')
    }
  })
})
