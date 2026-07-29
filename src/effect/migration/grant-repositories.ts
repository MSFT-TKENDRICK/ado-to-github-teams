import {Effect} from 'effect'
import type {RepositoryGrant} from '../../types/index.js'
import {ConflictFailure, PermissionFailure, ValidationFailure} from '../errors.js'
import {ApprovalServiceTag, GitHubServiceTag} from '../services.js'
import {requestCheckpointedApproval} from './approval.js'
import type {ApplyBudget} from './budget.js'
import {appendFailure} from './state.js'
import type {MigrationStateStore} from './state-store.js'
import {repositoryRoleRank} from './topology.js'

function grantKey(grant: RepositoryGrant): string {
  return `${grant.teamSlug}:${grant.repository}:${grant.role}`
}

export function grantRepositories(store: MigrationStateStore, budget?: ApplyBudget) {
  return Effect.gen(function* () {
    const github = yield* GitHubServiceTag
    const approval = yield* ApprovalServiceTag
    const getBasePermission = github.getOrganizationBasePermission
    const getRepository = github.getRepository
    const listTeamRepositories = github.listTeamRepositories
    const isTeamIdpManaged = github.isTeamIdpManaged
    const getPermission = github.getTeamRepositoryPermission
    const setPermission = github.setTeamRepositoryPermission
    if (
      !getBasePermission ||
      !getRepository ||
      !listTeamRepositories ||
      !isTeamIdpManaged ||
      !getPermission ||
      !setPermission
    ) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'github',
          message: 'GitHub adapter does not support repository permission orchestration.',
        }),
      )
    }

    const initial = yield* store.get
    const pending = (initial.repositoryGrants ?? []).filter(
      (grant) => !(initial.completedRepositoryGrants ?? []).includes(grantKey(grant)),
    )
    if (pending.length === 0) {
      return
    }

    for (const planned of initial.teamPlan ?? []) {
      const team = yield* github.getTeamBySlug(planned.team.slug)
      if (
        !team ||
        team.name !== planned.team.name ||
        team.privacy !== 'closed' ||
        (team.parentTeam?.slug ?? undefined) !== planned.parentSlug
      ) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Team ${planned.team.slug} changed after hierarchy preflight; rerun the topology plan.`,
          }),
        )
      }
      if (yield* isTeamIdpManaged(planned.team.slug)) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Team ${planned.team.slug} became identity-provider managed after hierarchy preflight.`,
          }),
        )
      }
      if (
        (planned.kind === 'organizational-unit' || planned.kind === 'project') &&
        (yield* listTeamRepositories(planned.team.slug)).length > 0
      ) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Structural team ${planned.team.slug} received repository access after hierarchy preflight.`,
          }),
        )
      }
    }

    const basePermission = yield* getBasePermission()
    const proposed: RepositoryGrant[] = []
    for (const grant of pending) {
      const repository = yield* getRepository(grant.repository)
      if (
        repository.fullName.toLowerCase() !== grant.repository.toLowerCase() ||
        repository.archived ||
        repository.visibility !== grant.visibility ||
        basePermission !== grant.basePermission
      ) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Repository or organization policy for ${grant.repository} changed after preflight; rerun the topology plan.`,
          }),
        )
      }
      if (repositoryRoleRank(basePermission) > repositoryRoleRank(grant.role)) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Organization base permission ${basePermission} exceeds proposed ${grant.role} access for ${grant.repository}.`,
          }),
        )
      }
      const current = yield* getPermission(grant.teamSlug, grant.repository)
      if (current === grant.role) {
        const state = yield* store.get
        yield* store.save({
          ...state,
          completedRepositoryGrants: [
            ...new Set([...(state.completedRepositoryGrants ?? []), grantKey(grant)]),
          ],
        })
        continue
      }
      if (current && repositoryRoleRank(current) > repositoryRoleRank(grant.role)) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Refusing to downgrade ${grant.teamSlug}/${grant.repository} from ${current} to ${grant.role}.`,
          }),
        )
      }
      proposed.push(grant)
    }
    if (proposed.length === 0) {
      return
    }

    const approved = yield* requestCheckpointedApproval(store, {
      action: `Grant ${proposed.length} repository permissions in ${initial.githubOrg}`,
      context: {
        grantCount: proposed.length,
        githubOrg: initial.githubOrg,
        grants: proposed.map((grant) => grantKey(grant)),
      },
      displayLines: proposed.map(
        (grant) =>
          `${grant.teamSlug} -> ${grant.repository}: ${grant.role} (organization base: ${grant.basePermission}, visibility: ${grant.visibility})`,
      ),
      autoApprovable: false,
    })
    if (!approved) {
      return yield* Effect.fail(
        new PermissionFailure({
          service: 'approval',
          message: 'Destructive repository grants not approved',
          ssoRequired: false,
        }),
      )
    }

    for (const grant of proposed) {
      let state = yield* store.get
      const key = grantKey(grant)
      if ((state.completedRepositoryGrants ?? []).includes(key)) {
        continue
      }
      if (budget && !(yield* budget.consume)) {
        break
      }
      const repository = yield* getRepository(grant.repository)
      const currentBasePermission = yield* getBasePermission()
      if (
        repository.fullName.toLowerCase() !== grant.repository.toLowerCase() ||
        repository.archived ||
        repository.visibility !== grant.visibility ||
        currentBasePermission !== grant.basePermission
      ) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Repository or organization policy for ${grant.repository} changed after approval; no grant was applied.`,
          }),
        )
      }
      const current = yield* getPermission(grant.teamSlug, grant.repository)
      if (current === grant.role) {
        yield* store.save({
          ...state,
          completedRepositoryGrants: [
            ...new Set([...(state.completedRepositoryGrants ?? []), key]),
          ],
          approvalHistory: yield* approval.history,
        })
        continue
      }
      if (current && repositoryRoleRank(current) > repositoryRoleRank(grant.role)) {
        return yield* Effect.fail(
          new ConflictFailure({
            service: 'github',
            message: `Refusing to downgrade ${grant.teamSlug}/${grant.repository} from ${current} to ${grant.role}.`,
          }),
        )
      }

      yield* store.save(state)
      const applied = yield* Effect.either(
        setPermission(grant.teamSlug, grant.repository, grant.role),
      )
      if (applied._tag === 'Left') {
        state = appendFailure(
          state,
          applied.left,
          'Recorded repository grant failure',
          `${grant.teamSlug}:${grant.repository}`,
        )
        yield* store.save(state)
        return yield* Effect.fail(applied.left)
      }
      state = yield* store.get
      yield* store.save({
        ...state,
        completedRepositoryGrants: [...new Set([...(state.completedRepositoryGrants ?? []), key])],
        approvalHistory: yield* approval.history,
      })
    }
  })
}
