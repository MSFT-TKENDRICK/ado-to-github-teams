import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Effect, Exit, Ref} from 'effect'
import type {SkippedItem} from '../types/index.js'
import {assignMembers} from './migration/assign-members.js'
import {createTeams} from './migration/create-teams.js'
import {openMigrationSession} from './migration/lifecycle.js'
import type {EffectMigrationOptions} from './migration/options.js'
import {
  advancePhase,
  fetchTeamsPhase,
  mapTeamsPhase,
  writeMigrationReport,
} from './migration/phases.js'

export type {EffectMigrationOptions} from './migration/options.js'

export function runEffectMigration(
  options: EffectMigrationOptions,
) {
  return Effect.gen(function* () {
    const startedAt = Date.now()
    const skippedRef = yield* Ref.make<SkippedItem[]>([])
    const session = yield* openMigrationSession(
      options,
      randomUUID(),
      new Date().toISOString(),
    )
    const currentAtStart = yield* session.store.get
    const reportPath =
      options.output ?? path.resolve(process.cwd(), `migration-report-${currentAtStart.runId}.md`)

    const program = Effect.gen(function* () {
      let state = yield* session.store.get

      if (state.phase === 'fetch') {
        yield* fetchTeamsPhase(session.store, options.adoProject, new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'map') {
        yield* mapTeamsPhase(session.store, options, new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'dry-run') {
        yield* writeMigrationReport(session.store, {
          dryRun: !options.apply,
          skippedItems: yield* Ref.get(skippedRef),
          outputPath: reportPath,
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        })
        if (!options.apply) {
          yield* session.complete
          return {reportPath, runId: state.runId}
        }
        yield* advancePhase(session.store, 'create-teams', new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'create-teams') {
        const skipped = yield* createTeams(session.store)
        yield* Ref.update(skippedRef, (items) => [...items, ...skipped])
        yield* advancePhase(session.store, 'assign-members', new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'assign-members') {
        const skipped = yield* assignMembers(session.store)
        yield* Ref.update(skippedRef, (items) => [...items, ...skipped])
        yield* advancePhase(session.store, 'report', new Date().toISOString())
      }

      state = yield* session.store.get
      yield* writeMigrationReport(session.store, {
        dryRun: false,
        skippedItems: yield* Ref.get(skippedRef),
        outputPath: reportPath,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      })
      yield* session.complete
      return {reportPath, runId: state.runId}
    })

    const exit = yield* Effect.exit(program)
    yield* session.flush
    return yield* Exit.matchEffect(exit, {
      onFailure: Effect.failCause,
      onSuccess: Effect.succeed,
    })
  })
}
