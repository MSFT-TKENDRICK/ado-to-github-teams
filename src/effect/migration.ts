import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Effect, Ref} from 'effect'
import type {CheckpointState, SkippedItem} from '../types/index.js'
import {NotFoundFailure} from './errors.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  CheckpointStoreTag,
  ReportWriterTag,
} from './services.js'
import {assignMembers} from './migration/assign-members.js'
import {createTeams} from './migration/create-teams.js'
import {mapTeams} from './migration/map-teams.js'
import type {EffectMigrationOptions} from './migration/options.js'
import {createInitialState, createMigrationReport} from './migration/state.js'
import type {MigrationStateStore} from './migration/state-store.js'

export type {EffectMigrationOptions} from './migration/options.js'

export function runEffectMigration(
  options: EffectMigrationOptions,
) {
  return Effect.gen(function* () {
    const ado = yield* AdoServiceTag
    const checkpoints = yield* CheckpointStoreTag
    const approval = yield* ApprovalServiceTag
    const reportWriter = yield* ReportWriterTag

    const startedAt = Date.now()
    const skippedRef = yield* Ref.make<SkippedItem[]>([])
    const shouldPersistRef = yield* Ref.make(true)
    const loadedState = options.resume ? yield* checkpoints.load(options.resume) : null
    if (options.resume && !loadedState) {
      return yield* Effect.fail(
        new NotFoundFailure({
          service: 'checkpoint',
          message: `Checkpoint ${options.resume} was not found.`,
        }),
      )
    }
    const stateRef = yield* Ref.make(
      loadedState ?? createInitialState(options, randomUUID(), new Date().toISOString()),
    )
    if (!loadedState) {
      yield* checkpoints.save(yield* Ref.get(stateRef))
    }

    const saveState = (next: CheckpointState) =>
      Ref.set(stateRef, next).pipe(Effect.zipRight(checkpoints.save(next)))
    const store: MigrationStateStore = {
      get: Ref.get(stateRef),
      save: saveState,
    }

    const currentAtStart = yield* Ref.get(stateRef)
    const reportPath =
      options.output ?? path.resolve(process.cwd(), `migration-report-${currentAtStart.runId}.md`)

    const program = Effect.gen(function* () {
      let state = yield* Ref.get(stateRef)

      if (state.phase === 'fetch') {
        const teams = yield* ado.getTeams(options.adoProject)
        state = {
          ...state,
          phase: 'map',
          pendingTeams: teams,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      if (state.phase === 'map') {
        const mapped = yield* mapTeams(state.pendingTeams, options)
        state = {
          ...state,
          phase: 'dry-run',
          mappings: mapped,
          edgeCases: mapped.flatMap((m) => m.edgeCases),
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      if (state.phase === 'dry-run') {
        const report = createMigrationReport(
          state,
          !options.apply,
          yield* Ref.get(skippedRef),
          new Date().toISOString(),
        )
        yield* reportWriter.write(report, reportPath, Date.now() - startedAt)
        if (!options.apply) {
          yield* checkpoints.delete(state.runId)
          yield* Ref.set(shouldPersistRef, false)
          return {reportPath, runId: state.runId}
        }
        state = {
          ...state,
          phase: 'create-teams',
          approvalHistory: yield* approval.history,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      if (state.phase === 'create-teams') {
        const skipped = yield* createTeams(store)
        yield* Ref.update(skippedRef, (items) => [...items, ...skipped])

        state = {
          ...(yield* Ref.get(stateRef)),
          phase: 'assign-members',
          approvalHistory: yield* approval.history,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      state = yield* Ref.get(stateRef)
      if (state.phase === 'assign-members') {
        const skipped = yield* assignMembers(store)
        yield* Ref.update(skippedRef, (items) => [...items, ...skipped])

        state = {
          ...(yield* Ref.get(stateRef)),
          phase: 'report',
          timestamp: new Date().toISOString(),
          approvalHistory: yield* approval.history,
        }
        yield* saveState(state)
      }

      state = yield* Ref.get(stateRef)
      const report = createMigrationReport(
        state,
        false,
        yield* Ref.get(skippedRef),
        new Date().toISOString(),
      )
      yield* reportWriter.write(report, reportPath, Date.now() - startedAt)
      yield* checkpoints.delete(state.runId)
      yield* Ref.set(shouldPersistRef, false)
      return {reportPath, runId: state.runId}
    })

    return yield* program.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const shouldPersist = yield* Ref.get(shouldPersistRef)
          if (!shouldPersist) {
            return
          }
          const latest = yield* Ref.get(stateRef)
          yield* checkpoints.save(latest).pipe(Effect.catchAll(() => Effect.void))
        }),
      ),
    )
  })
}
