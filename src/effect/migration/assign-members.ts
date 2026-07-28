import {Effect} from 'effect'
import type {SkippedItem} from '../../types/index.js'
import {NotFoundFailure, PermissionFailure, ValidationFailure} from '../errors.js'
import {ApprovalServiceTag, GitHubServiceTag} from '../services.js'
import {requestCheckpointedApproval} from './approval.js'
import {appendFailure} from './state.js'
import type {MigrationStateStore} from './state-store.js'

interface MemberAssignment {
  readonly slug: string
  readonly login: string
  readonly pair: string
}

function assignmentsFromState(
  state: import('../../types/index.js').CheckpointState,
): MemberAssignment[] {
  const assignments = new Map<string, MemberAssignment>()
  for (const mapping of state.mappings) {
    for (const member of mapping.memberMappings) {
      const login = member.githubUser?.login
      if (!member.mapped || !login) {
        continue
      }
      const pair = `${mapping.githubTeam.slug}:${login}`
      assignments.set(pair, {slug: mapping.githubTeam.slug, login, pair})
    }
  }
  return [...assignments.values()]
}

export function assignMembers(store: MigrationStateStore) {
  return Effect.gen(function* () {
    const github = yield* GitHubServiceTag
    const approval = yield* ApprovalServiceTag
    const initial = yield* store.get
    const pending = assignmentsFromState(initial).filter(
      (assignment) => !initial.completedMemberPairs.includes(assignment.pair),
    )
    const approved = yield* requestCheckpointedApproval(store, {
      action: `Add ${pending.length} members across ${initial.mappings.length} teams`,
      context: {memberCount: pending.length, teamCount: initial.mappings.length},
      displayLines: pending.map((assignment) => assignment.pair),
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

    const skipped: SkippedItem[] = []
    for (const assignment of pending) {
      let state = yield* store.get
      if (state.completedMemberPairs.includes(assignment.pair)) {
        continue
      }

      // Membership writes are idempotent, but checkpoint every unit for deterministic resume.
      yield* store.save(state)
      const assigned = yield* Effect.either(
        github.addTeamMember(assignment.slug, assignment.login),
      )
      if (assigned._tag === 'Left') {
        state = appendFailure(state, assigned.left, 'Recorded member add failure')
        yield* store.save(state)
        if (assigned.left instanceof PermissionFailure && assigned.left.ssoRequired) {
          const skip = yield* requestCheckpointedApproval(store, {
            action: 'Skip SSO-enforced member write',
            context: {team: assignment.slug, login: assignment.login},
            displayLines: [assigned.left.message],
            autoApprovable: false,
          })
          if (!skip) {
            return yield* Effect.fail(assigned.left)
          }
          skipped.push({
            type: 'member',
            name: assignment.pair,
            reason: assigned.left.message,
          })
          continue
        }

        if (
          (assigned.left instanceof ValidationFailure && assigned.left.status === 422) ||
          assigned.left instanceof NotFoundFailure
        ) {
          skipped.push({
            type: 'member',
            name: assignment.pair,
            reason: assigned.left.message,
          })
          continue
        }

        return yield* Effect.fail(assigned.left)
      }

      state = yield* store.get
      yield* store.save({
        ...state,
        completedMemberPairs: [
          ...new Set([...state.completedMemberPairs, assignment.pair]),
        ],
        approvalHistory: yield* approval.history,
      })
    }

    return skipped
  })
}
