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

function checkpointMismatch(
  state: CheckpointState,
  options: EffectMigrationOptions,
): string | null {
  const expected = {
    adoOrg: options.adoOrg,
    adoProject: options.adoProject,
    githubOrg: options.githubOrg,
    apply: options.apply,
    prefix: options.prefix ?? '',
    suffix: options.suffix ?? '',
  }
  const actual = {
    adoOrg: state.adoOrg,
    adoProject: state.adoProject,
    githubOrg: state.githubOrg,
    apply: state.migrationConfig.apply,
    prefix: state.migrationConfig.prefix,
    suffix: state.migrationConfig.suffix,
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
): Effect.Effect<MigrationSession, import('../errors.js').DomainFailure, CheckpointStoreTag> {
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointStoreTag
    const candidate = options.resume
      ? yield* checkpoints.load(options.resume)
      : options.autoResume === false
        ? null
        : yield* checkpoints.latest
    if (options.resume && !candidate) {
      return yield* Effect.fail(
        new NotFoundFailure({
          service: 'checkpoint',
          message: `Checkpoint ${options.resume} was not found.`,
        }),
      )
    }
    const mismatch = candidate ? checkpointMismatch(candidate, options) : null
    if (options.resume && candidate && mismatch) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'checkpoint',
          message: `Checkpoint ${candidate.runId} is incompatible with the requested migration scope: ${mismatch}.`,
        }),
      )
    }
    const loaded = mismatch ? null : candidate

    const stateRef = yield* Ref.make(loaded ?? createInitialState(options, runId, timestamp))
    if (!loaded) {
      yield* checkpoints.save(yield* Ref.get(stateRef))
    }
    const shouldPersistRef = yield* Ref.make(true)
    const dirtyRef = yield* Ref.make(false)
    const save = (state: CheckpointState) =>
      Ref.set(dirtyRef, true).pipe(
        Effect.zipRight(Ref.set(stateRef, state)),
        Effect.zipRight(checkpoints.save(state)),
        Effect.zipRight(Ref.set(dirtyRef, false)),
      )
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
          if (yield* Ref.get(dirtyRef)) {
            yield* checkpoints.save(yield* store.get)
            yield* Ref.set(dirtyRef, false)
          }
        }
      }),
    }
  })
}
