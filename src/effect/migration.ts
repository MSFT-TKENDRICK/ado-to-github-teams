import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Effect, Ref} from 'effect'
import type {CheckpointState, SkippedItem} from '../types/index.js'
import {
  NotFoundFailure,
  PermissionFailure,
  ValidationFailure,
} from './errors.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  CheckpointStoreTag,
  GitHubServiceTag,
  ReportWriterTag,
} from './services.js'
import {mapTeams} from './migration/map-teams.js'
import type {EffectMigrationOptions} from './migration/options.js'
import {
  appendFailure,
  createInitialState,
  createMigrationReport,
} from './migration/state.js'

export type {EffectMigrationOptions} from './migration/options.js'

export function runEffectMigration(
  options: EffectMigrationOptions,
) {
  return Effect.gen(function* () {
    const ado = yield* AdoServiceTag
    const github = yield* GitHubServiceTag
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
        const approved = yield* approval.request({
          action: `Create ${state.mappings.length} teams in ${state.githubOrg}`,
          context: {teamCount: state.mappings.length, githubOrg: state.githubOrg},
          displayLines: state.mappings.map((m) => `- ${m.githubTeam.slug}`),
          autoApprovable: false,
        })
        if (!approved) {
          return yield* Effect.fail(
            new PermissionFailure({
              service: 'approval',
              message: 'Destructive team creation not approved',
              ssoRequired: false,
            }),
          )
        }

        for (const mapping of state.mappings) {
          state = yield* Ref.get(stateRef)
          if (state.completedTeams.includes(mapping.githubTeam.slug)) {
            continue
          }
          const created = yield* Effect.either(
            github.createTeam({
              slug: mapping.githubTeam.slug,
              name: mapping.githubTeam.name,
              privacy: mapping.githubTeam.privacy,
              ...(mapping.githubTeam.description ? {description: mapping.githubTeam.description} : {}),
            }),
          )
          if (created._tag === 'Left') {
            state = appendFailure(state, created.left, 'Recorded team create failure')
            yield* saveState(state)
            if (created.left instanceof PermissionFailure && created.left.ssoRequired) {
              const skip = yield* approval.request({
                action: 'Skip SSO-enforced team write',
                context: {team: mapping.githubTeam.slug},
                displayLines: [created.left.message],
                autoApprovable: false,
              })
              if (!skip) {
                return yield* Effect.fail(created.left)
              }
              yield* Ref.update(skippedRef, (items) => [
                ...items,
                {type: 'team' as const, name: mapping.githubTeam.name, reason: created.left.message},
              ])
              continue
            }

            return yield* Effect.fail(created.left)
          }

          state = {
            ...state,
            completedTeams: [...state.completedTeams, mapping.githubTeam.slug],
            approvalHistory: yield* approval.history,
          }
          yield* saveState(state)
        }

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
        const plannedMembers = state.mappings.flatMap((mapping) =>
          mapping.memberMappings
            .filter((member) => member.mapped && member.githubUser)
            .map((member) => `${mapping.githubTeam.slug}:${member.githubUser?.login ?? ''}`),
        )
        const approved = yield* approval.request({
          action: `Add ${plannedMembers.length} members across ${state.mappings.length} teams`,
          context: {memberCount: plannedMembers.length, teamCount: state.mappings.length},
          displayLines: [`Assignments: ${plannedMembers.length}`],
          autoApprovable: false,
        })
        if (!approved) {
          return yield* Effect.fail(
            new PermissionFailure({
              service: 'approval',
              message: 'Destructive member assignment not approved',
              ssoRequired: false,
            }),
          )
        }

        for (const mapping of state.mappings) {
          for (const member of mapping.memberMappings) {
            const login = member.githubUser?.login
            if (!member.mapped || !login) {
              continue
            }
            state = yield* Ref.get(stateRef)
            const pair = `${mapping.githubTeam.slug}:${login}`
            if (state.completedMemberPairs.includes(pair)) {
              continue
            }
            const assigned = yield* Effect.either(github.addTeamMember(mapping.githubTeam.slug, login))
            if (assigned._tag === 'Left') {
              state = appendFailure(state, assigned.left, 'Recorded member add failure')
              yield* saveState(state)
              if (assigned.left instanceof PermissionFailure && assigned.left.ssoRequired) {
                const skip = yield* approval.request({
                  action: 'Skip SSO-enforced member write',
                  context: {team: mapping.githubTeam.slug, login},
                  displayLines: [assigned.left.message],
                  autoApprovable: false,
                })
                if (!skip) {
                  return yield* Effect.fail(assigned.left)
                }
                yield* Ref.update(skippedRef, (items) => [
                  ...items,
                  {type: 'member' as const, name: pair, reason: assigned.left.message},
                ])
                continue
              }

              if (
                (assigned.left instanceof ValidationFailure && assigned.left.status === 422) ||
                assigned.left instanceof NotFoundFailure
              ) {
                yield* Ref.update(skippedRef, (items) => [
                  ...items,
                  {type: 'member' as const, name: pair, reason: assigned.left.message},
                ])
                continue
              }

              return yield* Effect.fail(assigned.left)
            }
            state = {
              ...state,
              completedMemberPairs: [...state.completedMemberPairs, pair],
              approvalHistory: yield* approval.history,
            }
            yield* saveState(state)
          }
        }

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
