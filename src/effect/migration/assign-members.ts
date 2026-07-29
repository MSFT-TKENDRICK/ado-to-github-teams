import {Effect} from 'effect'
import type {SkippedItem} from '../../types/index.js'
import {PermissionFailure} from '../errors.js'
import {ApprovalServiceTag, GitHubServiceTag} from '../services.js'
import {requestCheckpointedApproval} from './approval.js'
import {resolveWithHealingInference} from './healing.js'
import {appendFailure, resolveAutomaticRetry} from './state.js'
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
    if (!state.completedTeams.includes(mapping.githubTeam.slug)) {
      continue
    }
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

      let retryCount = 0
      let completed = false
      while (!completed) {
        // Membership writes are idempotent, but checkpoint every unit for deterministic resume.
        yield* store.save(state)
        const assigned = yield* Effect.either(
          github.addTeamMember(assignment.slug, assignment.login),
        )
        if (assigned._tag === 'Right') {
          completed = true
          break
        }

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
          state = yield* store.get
          yield* store.save({
            ...state,
            skippedItems: [...state.skippedItems, skipped[skipped.length - 1]!],
          })
          completed = true
          break
        }

        const resolution = yield* resolveWithHealingInference(
          store,
          assigned.left,
          {
            operation: 'assign-member',
            target: assignment.pair,
            targetType: 'member',
            operationKind: 'write',
            idempotent: true,
            checkpointed: true,
            retryCount,
          },
        )
        if (resolution === 'retry') {
          retryCount += 1
          state = yield* store.get
          continue
        }
        if (resolution === 'skip') {
          skipped.push({
            type: 'member',
            name: assignment.pair,
            reason: assigned.left.message,
          })
          state = yield* store.get
          yield* store.save({
            ...state,
            skippedItems: [...state.skippedItems, skipped[skipped.length - 1]!],
          })
          completed = true
          break
        }

        return yield* Effect.fail(assigned.left)
      }

      if (skipped.some((item) => item.name === assignment.pair)) {
        continue
      }
      state = yield* store.get
      if (retryCount > 0) {
        state = resolveAutomaticRetry(state, assignment.pair)
      }
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
