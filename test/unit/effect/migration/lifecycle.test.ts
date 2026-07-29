import {describe, expect, it} from 'vitest'
import {Effect, Layer} from 'effect'
import {openMigrationSession} from '../../../../src/effect/migration/lifecycle.js'
import {
  CheckpointStoreTag,
  type CheckpointStore,
} from '../../../../src/effect/services.js'
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
})
