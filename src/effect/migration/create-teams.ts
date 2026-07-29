import {Effect} from 'effect'
import type {GitHubTeam, SkippedItem} from '../../types/index.js'
import {ConflictFailure, PermissionFailure} from '../errors.js'
import {ApprovalServiceTag, GitHubServiceTag} from '../services.js'
import {requestCheckpointedApproval} from './approval.js'
import {appendFailure} from './state.js'
import type {MigrationStateStore} from './state-store.js'

function sameTeam(existing: GitHubTeam, desired: GitHubTeam): boolean {
  return (
    existing.slug === desired.slug &&
    existing.name === desired.name &&
    existing.privacy === desired.privacy &&
    (desired.description === undefined || existing.description === desired.description)
  )
}

export function createTeams(store: MigrationStateStore) {
  return Effect.gen(function* () {
    const github = yield* GitHubServiceTag
    const approval = yield* ApprovalServiceTag
    const initial = yield* store.get
    const pending = initial.mappings.filter(
      (mapping) => !initial.completedTeams.includes(mapping.githubTeam.slug),
    )
    const approved = yield* requestCheckpointedApproval(store, {
      action: `Create ${pending.length} teams in ${initial.githubOrg}`,
      context: {teamCount: pending.length, githubOrg: initial.githubOrg},
      displayLines: pending.map((mapping) => JSON.stringify(mapping.githubTeam)),
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

    const skipped: SkippedItem[] = []
    for (const mapping of pending) {
      let state = yield* store.get
      if (state.completedTeams.includes(mapping.githubTeam.slug)) {
        continue
      }

      const existing = yield* github.getTeamBySlug(mapping.githubTeam.slug)
      if (existing) {
        if (!sameTeam(existing, mapping.githubTeam)) {
          return yield* Effect.fail(
            new ConflictFailure({
              service: 'github',
              message: `GitHub team ${mapping.githubTeam.slug} exists with different settings`,
            }),
          )
        }
      } else {
        // Persist the latest validated state immediately before the resumable write unit.
        yield* store.save(state)
        // Do not retry this POST: a lost response may hide a successful create. Resume verifies
        // the slug with getTeamBySlug before issuing another write.
        const created = yield* Effect.either(
          github.createTeam({
            slug: mapping.githubTeam.slug,
            name: mapping.githubTeam.name,
            privacy: mapping.githubTeam.privacy,
            ...(mapping.githubTeam.description
              ? {description: mapping.githubTeam.description}
              : {}),
          }),
        )
        if (created._tag === 'Left') {
          state = appendFailure(state, created.left, 'Recorded team create failure')
          yield* store.save(state)
          if (created.left instanceof PermissionFailure && created.left.ssoRequired) {
            const skip = yield* requestCheckpointedApproval(store, {
              action: 'Skip SSO-enforced team write',
              context: {team: mapping.githubTeam.slug},
              displayLines: [created.left.message],
              autoApprovable: false,
            })
            if (!skip) {
              return yield* Effect.fail(created.left)
            }
            skipped.push({
              type: 'team',
              name: mapping.githubTeam.name,
              reason: created.left.message,
            })
            state = yield* store.get
            yield* store.save({
              ...state,
              skippedItems: [...state.skippedItems, skipped[skipped.length - 1]!],
            })
            continue
          }

          return yield* Effect.fail(created.left)
        }
      }

      state = yield* store.get
      yield* store.save({
        ...state,
        completedTeams: [...new Set([...state.completedTeams, mapping.githubTeam.slug])],
        approvalHistory: yield* approval.history,
      })
    }

    return skipped
  })
}
