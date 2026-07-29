import {Effect} from 'effect'
import type {GitHubTeam, PlannedTeam, SkippedItem} from '../../types/index.js'
import {ConflictFailure, PermissionFailure} from '../errors.js'
import {ApprovalServiceTag, GitHubServiceTag} from '../services.js'
import {requestCheckpointedApproval} from './approval.js'
import type {ApplyBudget} from './budget.js'
import {resolveWithHealingInference} from './healing.js'
import {appendFailure} from './state.js'
import type {MigrationStateStore} from './state-store.js'

function sameTeam(existing: GitHubTeam, desired: PlannedTeam): boolean {
  return (
    existing.slug === desired.team.slug &&
    existing.name === desired.team.name &&
    existing.privacy === desired.team.privacy &&
    (desired.team.description === undefined ||
      existing.description === desired.team.description) &&
    (existing.parentTeam?.slug ?? undefined) === desired.parentSlug
  )
}

export function createTeams(store: MigrationStateStore, budget?: ApplyBudget) {
  return Effect.gen(function* () {
    const github = yield* GitHubServiceTag
    const approval = yield* ApprovalServiceTag
    const initial = yield* store.get
    const plan: PlannedTeam[] =
      initial.teamPlan && initial.teamPlan.length > 0
        ? initial.teamPlan
        : initial.mappings.map((mapping) => ({
            team: mapping.githubTeam,
            kind: 'flat' as const,
            sourceAdoTeamIds: [mapping.adoTeam.id],
          }))
    const pending = plan.filter(
      (planned) =>
        !initial.completedTeams.includes(planned.team.slug) &&
        !initial.skippedItems.some(
          (item) =>
            item.type === 'team' &&
            (item.name === planned.team.slug || item.name === planned.team.name),
        ),
    )
    const approved = yield* requestCheckpointedApproval(store, {
      action: `Create ${pending.length} teams in ${initial.githubOrg}`,
      context: {teamCount: pending.length, githubOrg: initial.githubOrg},
      displayLines: pending.map((planned) =>
        planned.kind === 'flat'
          ? JSON.stringify(planned.team)
          : JSON.stringify({
              ...planned.team,
              kind: planned.kind,
              ...(planned.parentSlug ? {parentSlug: planned.parentSlug} : {}),
            }),
      ),
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
    for (const planned of pending) {
      let state = yield* store.get
      if (state.completedTeams.includes(planned.team.slug)) {
        continue
      }
      if (budget && !(yield* budget.consume)) {
        break
      }
      let parentTeamId: number | undefined
      if (planned.parentSlug) {
        const parent = yield* github.getTeamBySlug(planned.parentSlug)
        if (!parent?.id || !state.completedTeams.includes(planned.parentSlug)) {
          return yield* Effect.fail(
            new ConflictFailure({
              service: 'github',
              message: `Parent team ${planned.parentSlug} is not available before child ${planned.team.slug}.`,
            }),
          )
        }
        parentTeamId = parent.id
      }

      const existing = yield* github.getTeamBySlug(planned.team.slug)
      if (existing) {
        if (!sameTeam(existing, planned)) {
          return yield* Effect.fail(
            new ConflictFailure({
              service: 'github',
              message: `GitHub team ${planned.team.slug} exists with different settings or parent`,
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
            slug: planned.team.slug,
            name: planned.team.name,
            privacy: planned.team.privacy,
            ...(planned.team.description
              ? {description: planned.team.description}
              : {}),
            ...(parentTeamId === undefined ? {} : {parentTeamId}),
          }),
        )
        if (created._tag === 'Left') {
          state = appendFailure(
            state,
            created.left,
            'Recorded team create failure',
            planned.team.slug,
          )
          yield* store.save(state)
          if (created.left instanceof PermissionFailure && created.left.ssoRequired) {
            const skip = yield* requestCheckpointedApproval(store, {
              action: 'Skip SSO-enforced team write',
              context: {team: planned.team.slug},
              displayLines: [created.left.message],
              autoApprovable: false,
              elicitation: {
                kind: 'sso',
                operation: 'create-team',
                target: planned.team.slug,
                targetType: 'team',
                failureMode: created.left._tag,
                actionOnApprove: 'skip',
              },
            })
            if (!skip) {
              return yield* Effect.fail(created.left)
            }
            skipped.push({
              type: 'team',
              name: planned.team.name,
              reason: created.left.message,
            })
            state = yield* store.get
            yield* store.save({
              ...state,
              skippedItems: [...state.skippedItems, skipped[skipped.length - 1]!],
            })
            continue
          }

          const resolution = yield* resolveWithHealingInference(
            store,
            created.left,
            {
              operation: 'create-team',
              target: planned.team.slug,
              targetType: 'team',
              operationKind: 'write',
              idempotent: false,
              checkpointed: true,
              retryCount: 0,
            },
          )
          if (resolution === 'skip') {
            skipped.push({
              type: 'team',
              name: planned.team.name,
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
        if (!sameTeam(created.right, planned)) {
          const failure = new ConflictFailure({
            service: 'github',
            message: `GitHub created ${planned.team.slug} without the requested hierarchy settings`,
          })
          state = appendFailure(
            state,
            failure,
            'Created team did not match requested hierarchy',
            planned.team.slug,
          )
          yield* store.save(state)
          return yield* Effect.fail(failure)
        }
      }

      state = yield* store.get
      yield* store.save({
        ...state,
        completedTeams: [...new Set([...state.completedTeams, planned.team.slug])],
        approvalHistory: yield* approval.history,
      })
    }

    return skipped
  })
}
