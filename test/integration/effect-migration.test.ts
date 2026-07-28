import {describe, expect, it} from 'vitest'
import {Effect, Layer} from 'effect'
import {runEffectMigration} from '../../src/effect/migration.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  CheckpointStoreTag,
  EntraServiceTag,
  GitHubServiceTag,
  ReportWriterTag,
  type CheckpointStore,
} from '../../src/effect/services.js'
import type {CheckpointState} from '../../src/types/index.js'

function checkpointLayer(savedStates: CheckpointState[]): Layer.Layer<CheckpointStoreTag> {
  const store: CheckpointStore = {
    save: (state) =>
      Effect.sync(() => {
        savedStates.push(JSON.parse(JSON.stringify(state)) as CheckpointState)
      }),
    load: () => Effect.succeed(null),
    list: Effect.succeed([]),
    delete: () => Effect.void,
  }
  return Layer.succeed(CheckpointStoreTag, store)
}

describe('effect migration orchestration', () => {
  it('enforces bounded concurrency during map phase', async () => {
    let active = 0
    let peak = 0
    const saves: CheckpointState[] = []

    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed(
            Array.from({length: 6}, (_, index) => ({
              id: `t${index}`,
              name: `Team ${index}`,
              projectId: 'p1',
              projectName: 'Platform',
            })),
          ),
        getTeamMembers: () =>
          Effect.gen(function* () {
            active += 1
            peak = Math.max(peak, active)
            yield* Effect.sleep('10 millis')
            active -= 1
            return []
          }),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () => Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: () => Effect.succeed([]),
        resolveUserByUpn: () => Effect.succeed(null),
      }),
      checkpointLayer(saves),
      Layer.succeed(ApprovalServiceTag, {
        request: () => Effect.succeed(true),
        history: Effect.succeed([]),
      }),
      Layer.succeed(ReportWriterTag, {
        write: () => Effect.void,
      }),
    )

    await Effect.runPromise(
      runEffectMigration({
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: false,
        concurrency: 2,
      }).pipe(Effect.provide(layer)),
    )

    expect(peak).toBeLessThanOrEqual(2)
  })

  it('flushes checkpoint state when interrupted', async () => {
    const saves: CheckpointState[] = []
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.gen(function* () {
            yield* Effect.sleep('500 millis')
            return []
          }),
        getTeamMembers: () => Effect.succeed([]),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () => Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: () => Effect.succeed([]),
        resolveUserByUpn: () => Effect.succeed(null),
      }),
      checkpointLayer(saves),
      Layer.succeed(ApprovalServiceTag, {
        request: () => Effect.succeed(true),
        history: Effect.succeed([]),
      }),
      Layer.succeed(ReportWriterTag, {
        write: () => Effect.void,
      }),
    )

    await expect(
      Effect.runPromise(
        runEffectMigration({
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'contoso',
          apply: false,
          concurrency: 1,
        })
          .pipe(Effect.provide(layer), Effect.timeout('30 millis')),
      ),
    ).rejects.toThrow('Operation timed out')

    expect(saves.length).toBeGreaterThan(0)
  })

  it('does not bypass destructive approval gates', async () => {
    const saves: CheckpointState[] = []
    const destructiveRequests: boolean[] = []
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Team 1', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () =>
          Effect.succeed([
            {
              id: 'u1',
              displayName: 'Ada',
              uniqueName: 'ada@contoso.com',
              isContainer: false,
            },
          ]),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () => Effect.succeed({id: 1, slug: 'team-1', name: 'Team 1', privacy: 'closed'}),
        addTeamMember: () => Effect.void,
        findUserByEmail: () =>
          Effect.succeed({login: 'ada', type: 'User', email: 'ada@contoso.com'}),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: () => Effect.succeed([]),
        resolveUserByUpn: () =>
          Effect.succeed({
            id: 'u1',
            displayName: 'Ada',
            userPrincipalName: 'ada@contoso.com',
            mail: 'ada@contoso.com',
            isGuest: false,
            accountEnabled: true,
          }),
      }),
      checkpointLayer(saves),
      Layer.succeed(ApprovalServiceTag, {
        request: (request) =>
          Effect.sync(() => {
            destructiveRequests.push(!request.autoApprovable)
            return false
          }),
        history: Effect.succeed([]),
      }),
      Layer.succeed(ReportWriterTag, {
        write: () => Effect.void,
      }),
    )

    await expect(
      Effect.runPromise(
        runEffectMigration({
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'contoso',
          apply: true,
          concurrency: 1,
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('Destructive team creation not approved')

    expect(destructiveRequests.some(Boolean)).toBe(true)
  })
})
