import {Effect, Ref} from 'effect'
import type {CheckpointState} from '../../types/index.js'
import {NotFoundFailure, ValidationFailure} from '../errors.js'
import {CheckpointStoreTag} from '../services.js'
import type {EffectMigrationOptions} from './options.js'
import {createInitialState} from './state.js'
import type {MigrationStateStore} from './state-store.js'

export interface MigrationSession {
  readonly store: MigrationStateStore
  readonly complete: Effect.Effect<void, import('../errors.js').DomainFailure>
  readonly flush: Effect.Effect<void, import('../errors.js').DomainFailure>
}

export function openMigrationSession(
  options: EffectMigrationOptions,
  runId: string,
  timestamp: string,
): Effect.Effect<
  MigrationSession,
  import('../errors.js').DomainFailure,
  CheckpointStoreTag
> {
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointStoreTag
    const loaded = options.resume ? yield* checkpoints.load(options.resume) : null
    if (options.resume && !loaded) {
      return yield* Effect.fail(
        new NotFoundFailure({
          service: 'checkpoint',
          message: `Checkpoint ${options.resume} was not found.`,
        }),
      )
    }
    if (
      loaded &&
      (loaded.adoOrg !== options.adoOrg ||
        loaded.adoProject !== options.adoProject ||
        loaded.githubOrg !== options.githubOrg ||
        loaded.apply !== options.apply)
    ) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'checkpoint',
          message: `Checkpoint ${loaded.runId} is incompatible with the requested migration scope.`,
        }),
      )
    }

    const stateRef = yield* Ref.make(
      loaded ?? createInitialState(options, runId, timestamp),
    )
    if (!loaded) {
      yield* checkpoints.save(yield* Ref.get(stateRef))
    }
    const shouldPersistRef = yield* Ref.make(true)
    const save = (state: CheckpointState) =>
      Ref.set(stateRef, state).pipe(Effect.zipRight(checkpoints.save(state)))
    const store: MigrationStateStore = {
      get: Ref.get(stateRef),
      save,
    }

    return {
      store,
      complete: Effect.gen(function* () {
        const state = yield* store.get
        yield* checkpoints.delete(state.runId)
        yield* Ref.set(shouldPersistRef, false)
      }),
      flush: Effect.gen(function* () {
        if (yield* Ref.get(shouldPersistRef)) {
          yield* checkpoints.save(yield* store.get)
        }
      }),
    }
  })
}
