import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Effect} from 'effect'
import {assignMembers} from './migration/assign-members.js'
import {makeApplyBudget} from './migration/budget.js'
import {createTeams} from './migration/create-teams.js'
import {grantRepositories} from './migration/grant-repositories.js'
import {openMigrationSession} from './migration/lifecycle.js'
import type {EffectMigrationOptions} from './migration/options.js'
import {
  advancePhase,
  fetchTeamsPhase,
  mapTeamsPhase,
  writeMigrationReport,
} from './migration/phases.js'
import {publishMigrationProgress} from '../ui/migration-progress.js'

export type {EffectMigrationOptions} from './migration/options.js'

export interface EffectMigrationResult {
  readonly reportPath: string
  readonly runId: string
  readonly pendingApproval: boolean
  /**
   * True when an apply invocation stopped at a checkpoint boundary because its
   * batch budget was exhausted. The durable workflow re-invokes to resume the
   * remaining resumable units.
   */
  readonly pendingWork?: boolean
}

export function runEffectMigration(options: EffectMigrationOptions) {
  return Effect.gen(function* () {
    const startedAt = Date.now()
    const session = yield* openMigrationSession(
      options,
      options.runId ?? randomUUID(),
      new Date().toISOString(),
    )
    const currentAtStart = yield* session.store.get
    const reportPath =
      options.output ?? path.resolve(process.cwd(), `migration-report-${currentAtStart.runId}.md`)

    const budget = yield* makeApplyBudget({
      startedAtMs: startedAt,
      ...(options.applyBatch?.maxUnits !== undefined
        ? {maxUnits: options.applyBatch.maxUnits}
        : {}),
      ...(options.applyBatch?.softDeadlineMs !== undefined
        ? {softDeadlineMs: options.applyBatch.softDeadlineMs}
        : {}),
    })
    let lastProgressPhase: string = currentAtStart.phase

    const program = Effect.gen(function* () {
      let state = yield* session.store.get
      const publish = (
        phase: string,
        status: 'queued' | 'running' | 'completed',
        message: string,
      ) => {
        lastProgressPhase = phase
        return publishMigrationProgress({
          runId: state.runId,
          phase,
          status,
          message,
          updatedAt: new Date().toISOString(),
        })
      }

      if (state.phase === 'fetch') {
        yield* publish('fetch', 'running', 'Reading source teams and membership boundaries.')
        yield* fetchTeamsPhase(session.store, options.adoProject, new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'map') {
        yield* publish('map', 'running', 'Matching source identities to managed GitHub users.')
        yield* mapTeamsPhase(session.store, options, new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'dry-run') {
        yield* publish('dry-run', 'running', 'Building the exact migration plan and audit report.')
        yield* writeMigrationReport(session.store, {
          dryRun: !options.apply,
          outputPath: reportPath,
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        })
        if (!options.apply) {
          yield* session.complete
          yield* publish('report', 'completed', 'Dry-run report is ready for review.')
          return {reportPath, runId: state.runId, pendingApproval: false}
        }
        yield* advancePhase(session.store, 'create-teams', new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'create-teams') {
        yield* publish('create-teams', 'running', 'Creating approved GitHub team structures.')
        yield* createTeams(session.store, budget)
        if (yield* budget.wasExhausted) {
          yield* publish('create-teams', 'queued', 'Checkpoint saved; remaining teams are queued.')
          return {reportPath, runId: state.runId, pendingApproval: false, pendingWork: true}
        }
        yield* advancePhase(session.store, 'assign-members', new Date().toISOString())
        state = yield* session.store.get
      }

      if (state.phase === 'assign-members') {
        yield* publish('assign-members', 'running', 'Applying approved team memberships.')
        yield* assignMembers(session.store, budget)
        if (yield* budget.wasExhausted) {
          yield* publish(
            'assign-members',
            'queued',
            'Checkpoint saved; remaining memberships are queued.',
          )
          return {reportPath, runId: state.runId, pendingApproval: false, pendingWork: true}
        }
        yield* advancePhase(
          session.store,
          (state.repositoryGrants ?? []).length > 0 ? 'grant-repositories' : 'report',
          new Date().toISOString(),
        )
        state = yield* session.store.get
      }

      if (state.phase === 'grant-repositories') {
        yield* publish('grant-repositories', 'running', 'Applying approved repository permissions.')
        yield* grantRepositories(session.store, budget)
        if (yield* budget.wasExhausted) {
          yield* publish(
            'grant-repositories',
            'queued',
            'Checkpoint saved; remaining repository grants are queued.',
          )
          return {reportPath, runId: state.runId, pendingApproval: false, pendingWork: true}
        }
        yield* advancePhase(session.store, 'report', new Date().toISOString())
      }

      state = yield* session.store.get
      yield* publish('report', 'running', 'Writing the durable migration receipt.')
      yield* writeMigrationReport(session.store, {
        dryRun: false,
        outputPath: reportPath,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      })
      yield* session.complete
      yield* publish('report', 'completed', 'Migration report and durable receipt are ready.')
      return {reportPath, runId: state.runId, pendingApproval: false}
    })

    return yield* program.pipe(
      Effect.tapError(() =>
        publishMigrationProgress({
          runId: currentAtStart.runId,
          phase: lastProgressPhase,
          status: 'failed',
          message: 'Migration stopped; recovery guidance follows.',
          updatedAt: new Date().toISOString(),
        }),
      ),
      Effect.ensuring(session.flush.pipe(Effect.catchAll(() => Effect.void))),
    )
  })
}
