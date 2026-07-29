import {Effect} from 'effect'
import type {SkippedItem} from '../../types/index.js'
import {PermissionFailure, ValidationFailure} from '../errors.js'
import {ApprovalServiceTag, GitHubServiceTag} from '../services.js'
import {requestCheckpointedApproval} from './approval.js'
import {createEdgeCase} from './edge-cases.js'
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
    const isTeamIdpManaged = github.isTeamIdpManaged
    // Fail closed: without a way to detect IdP/SCIM-managed teams we cannot safely
    // write membership, even though the method is optional on the GitHub adapter type.
    if (!isTeamIdpManaged) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'github',
          message:
            'GitHub adapter does not support required hierarchy operation isTeamIdpManaged; refusing to write team membership without an IdP-managed-team safety check.',
        }),
      )
    }

    const initial = yield* store.get
    const candidates = assignmentsFromState(initial).filter(
      (assignment) =>
        !initial.completedMemberPairs.includes(assignment.pair) &&
        !initial.skippedItems.some(
          (item) => item.type === 'member' && item.name === assignment.pair,
        ),
    )

    // Detect IdP/SCIM-synchronized teams before proposing or writing any membership
    // change. This is re-evaluated on every run (including resume), so a team that
    // becomes synchronized after a prior run cannot be silently written to.
    const idpManagedBySlug = new Map<string, boolean>()
    for (const slug of new Set(candidates.map((assignment) => assignment.slug))) {
      idpManagedBySlug.set(slug, yield* isTeamIdpManaged(slug))
    }

    const blockedByIdp = candidates.filter(
      (assignment) => idpManagedBySlug.get(assignment.slug) === true,
    )
    const pending = candidates.filter(
      (assignment) => idpManagedBySlug.get(assignment.slug) !== true,
    )

    if (blockedByIdp.length > 0) {
      const state = yield* store.get
      const newSkippedItems: SkippedItem[] = []
      const newEdgeCases = state.edgeCases.slice()
      for (const assignment of blockedByIdp) {
        const details = `Team ${assignment.slug} is synchronized by an identity provider (SCIM/team-sync); membership for ${assignment.login} must not be written by this tool.`
        newSkippedItems.push({
          type: 'member',
          name: assignment.pair,
          reason: details,
        })
        newEdgeCases.push(createEdgeCase('idp-managed-team', details))
      }
      // Persist the fail-closed decision immediately so a resumed run re-derives
      // the same skip from state rather than re-attempting the write.
      yield* store.save({
        ...state,
        skippedItems: [...state.skippedItems, ...newSkippedItems],
        edgeCases: newEdgeCases,
      })
    }

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

    const skipped: SkippedItem[] = blockedByIdp.map((assignment) => ({
      type: 'member',
      name: assignment.pair,
      reason: `Team ${assignment.slug} is synchronized by an identity provider (SCIM/team-sync); membership for ${assignment.login} must not be written by this tool.`,
    }))
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

        state = appendFailure(
          state,
          assigned.left,
          'Recorded member add failure',
          assignment.pair,
        )
        yield* store.save(state)
        if (assigned.left instanceof PermissionFailure && assigned.left.ssoRequired) {
          const skip = yield* requestCheckpointedApproval(store, {
            action: 'Skip SSO-enforced member write',
            context: {team: assignment.slug, login: assignment.login},
            displayLines: [assigned.left.message],
            autoApprovable: false,
            elicitation: {
              kind: 'sso',
              operation: 'assign-member',
              target: assignment.pair,
              targetType: 'member',
              failureMode: assigned.left._tag,
              actionOnApprove: 'skip',
            },
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
