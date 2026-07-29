import {Effect, Ref} from 'effect'
import {configurationHash} from '../../checkpoints/configuration.js'
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

function checkpointMismatch(
  state: CheckpointState,
  options: EffectMigrationOptions,
): string | null {
  const expected = {
    adoOrg: options.adoOrg,
    adoProject: options.adoProject,
    githubOrg: options.githubOrg,
    prefix: options.prefix ?? '',
    suffix: options.suffix ?? '',
    topologyDigest: options.topology?.digest ?? '',
  }
  const actual = {
    adoOrg: state.adoOrg,
    adoProject: state.adoProject,
    githubOrg: state.githubOrg,
    prefix: state.migrationConfig.prefix,
    suffix: state.migrationConfig.suffix,
    topologyDigest: state.migrationConfig.topologyDigest ?? '',
  }
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (expected[key] !== actual[key]) {
      return `${key} expected ${JSON.stringify(actual[key])} but received ${JSON.stringify(expected[key])}`
    }
  }
  return null
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
    const checkpointId = options.resume ?? options.runId
    const loaded = checkpointId ? yield* checkpoints.load(checkpointId) : null
    if (options.resume && !loaded) {
      return yield* Effect.fail(
        new NotFoundFailure({
          service: 'checkpoint',
          message: `Checkpoint ${options.resume} was not found.`,
        }),
      )
    }
    const mismatch = loaded ? checkpointMismatch(loaded, options) : null
    if (
      loaded &&
      (loaded.configurationHash !== configurationHash(options) || mismatch)
    ) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'checkpoint',
          message: `Checkpoint ${loaded.runId} is incompatible with the requested migration configuration${mismatch ? `: ${mismatch}` : ''}.`,
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
        if (!options.preserveCheckpoint) {
          yield* checkpoints.delete(state.runId)
          yield* Ref.set(shouldPersistRef, false)
        }
      }),
      flush: Effect.gen(function* () {
        if (yield* Ref.get(shouldPersistRef)) {
          yield* checkpoints.save(yield* store.get)
        }
      }),
    }
  })
}
