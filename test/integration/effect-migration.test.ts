import {describe, expect, it, vi} from 'vitest'
import {Effect, Layer} from 'effect'
import {runEffectMigration} from '../../src/effect/migration.js'
import {PermissionFailure, ValidationFailure} from '../../src/effect/errors.js'
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

function checkpointLayer(
  savedStates: CheckpointState[],
  loadedState: CheckpointState | null = null,
): Layer.Layer<CheckpointStoreTag> {
  const store: CheckpointStore = {
    save: (state) =>
      Effect.sync(() => {
        savedStates.push(JSON.parse(JSON.stringify(state)) as CheckpointState)
      }),
    load: () => Effect.succeed(loadedState),
    latest: Effect.succeed(loadedState),
    list: Effect.succeed([]),
    delete: () => Effect.void,
  }
  return Layer.succeed(CheckpointStoreTag, store)
}

describe('effect migration orchestration', () => {
  it('finishes discovery in a background worker without crossing an approval gate', async () => {
    const saves: CheckpointState[] = []
    const requestApproval = vi.fn(() => Effect.succeed(true))
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Team 1', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
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
        request: requestApproval,
        history: Effect.succeed([]),
      }),
      Layer.succeed(ReportWriterTag, {
        write: () => Effect.void,
      }),
    )

    const result = await Effect.runPromise(
      runEffectMigration({
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: true,
        concurrency: 2,
        backgroundWorker: true,
      }).pipe(Effect.provide(layer)),
    )

    expect(result.pendingApproval).toBe(true)
    expect(requestApproval).not.toHaveBeenCalled()
    expect(saves.at(-1)?.phase).toBe('dry-run')
  })

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
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
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

  it('resolves ADO group containers to Entra group ids before expansion', async () => {
    const saves: CheckpointState[] = []
    const requestedGroupIds: string[] = []

    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Team 1', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () =>
          Effect.succeed([
            {
              id: 'ado-group-id',
              descriptor: 'vssgp.Uy0xLTktMTU1',
              displayName: 'Platform Contributors',
              uniqueName: 'Platform Contributors',
              isContainer: true,
            },
          ]),
        resolveGroupOriginId: () => Effect.succeed('entra-group-id'),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: (groupId) =>
          Effect.sync(() => {
            requestedGroupIds.push(groupId)
            return []
          }),
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
        concurrency: 1,
      }).pipe(Effect.provide(layer)),
    )

    expect(requestedGroupIds).toEqual(['entra-group-id'])
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
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
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
        }).pipe(Effect.provide(layer), Effect.timeout('30 millis')),
      ),
    ).rejects.toThrow('Operation timed out')

    expect(saves).toHaveLength(1)
  })

  it('does not issue a redundant flush that could mask the primary failure', async () => {
    let saveCount = 0
    const checkpointStore: CheckpointStore = {
      save: () =>
        Effect.suspend(() => {
          saveCount += 1
          return saveCount >= 3
            ? Effect.fail(
                new ValidationFailure({
                  service: 'checkpoint',
                  message: 'Checkpoint flush failed',
                }),
              )
            : Effect.void
        }),
      load: () => Effect.succeed(null),
      latest: Effect.succeed(null),
      list: Effect.succeed([]),
      delete: () => Effect.void,
    }
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Team 1', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () =>
          Effect.fail(
            new ValidationFailure({
              service: 'ado',
              message: 'Primary mapping failure',
            }),
          ),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: () => Effect.succeed([]),
        resolveUserByUpn: () => Effect.succeed(null),
      }),
      Layer.succeed(CheckpointStoreTag, checkpointStore),
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
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('Primary mapping failure')
    expect(saveCount).toBe(2)
  })

  it('does not bypass destructive approval gates', async () => {
    const saves: CheckpointState[] = []
    const destructiveRequests: boolean[] = []
    const approvalHistory: CheckpointState['approvalHistory'] = []
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
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'team-1', name: 'Team 1', privacy: 'closed'}),
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
            approvalHistory.push({
              action: request.action,
              context: JSON.stringify(request.context),
              approved: false,
              timestamp: '2026-07-28T00:00:00.000Z',
            })
            return false
          }),
        history: Effect.sync(() => [...approvalHistory]),
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
    expect(saves.at(-1)?.approvalHistory).toContainEqual(expect.objectContaining({approved: false}))
  })

  it('persists rejected member approval without assigning members', async () => {
    const saves: CheckpointState[] = []
    const approvalHistory: CheckpointState['approvalHistory'] = []
    const addTeamMember = vi.fn(() => Effect.void)
    let requestCount = 0
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Core', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () =>
          Effect.succeed([
            {
              id: 'u1',
              displayName: 'Ada',
              uniqueName: 'ada@contoso.com',
              isContainer: false,
            },
          ]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: (team) =>
          Effect.succeed({id: 1, slug: team.slug, name: team.name, privacy: team.privacy}),
        addTeamMember,
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
            requestCount += 1
            const approved = requestCount === 1
            approvalHistory.push({
              action: request.action,
              context: JSON.stringify(request.context),
              approved,
              timestamp: '2026-07-28T00:00:00.000Z',
            })
            return approved
          }),
        history: Effect.sync(() => [...approvalHistory]),
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
    ).rejects.toThrow('Destructive member assignment not approved')

    expect(addTeamMember).not.toHaveBeenCalled()
    expect(saves.at(-1)?.approvalHistory).toContainEqual(expect.objectContaining({approved: false}))
  })

  it('fails the migration when GitHub user lookup returns a non-ambiguity error', async () => {
    const saves: CheckpointState[] = []
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
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'team-1', name: 'Team 1', privacy: 'closed'}),
        addTeamMember: () => Effect.void,
        findUserByEmail: () =>
          Effect.fail(
            new ValidationFailure({
              service: 'github',
              message: 'GitHub user search is unavailable',
            }),
          ),
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
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('GitHub user search is unavailable')
  })

  it('fails the migration on non-SSO permission errors during team creation', async () => {
    const saves: CheckpointState[] = []
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Team 1', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.fail(
            new PermissionFailure({
              service: 'github',
              message: 'Missing team administration permission',
              status: 403,
              ssoRequired: false,
            }),
          ),
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
          apply: true,
          concurrency: 1,
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('Missing team administration permission')
  })

  it('fails the migration on non-SSO permission errors during member assignment', async () => {
    const saves: CheckpointState[] = []
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
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'team-1', name: 'Team 1', privacy: 'closed'}),
        addTeamMember: () =>
          Effect.fail(
            new PermissionFailure({
              service: 'github',
              message: 'Missing member administration permission',
              status: 403,
              ssoRequired: false,
            }),
          ),
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
          apply: true,
          concurrency: 1,
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('Missing member administration permission')
  })

  it('fails the migration on unknown member assignment validation failures', async () => {
    const saves: CheckpointState[] = []
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
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'team-1', name: 'Team 1', privacy: 'closed'}),
        addTeamMember: () =>
          Effect.fail(
            new ValidationFailure({
              service: 'github',
              message: 'Unexpected GitHub failure while assigning member',
            }),
          ),
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
          apply: true,
          concurrency: 1,
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('Unexpected GitHub failure while assigning member')
  })

  it('fails closed when a requested checkpoint resume id does not exist', async () => {
    const saves: CheckpointState[] = []
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () => Effect.succeed([]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
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
          resume: 'missing-run-id',
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('Checkpoint missing-run-id was not found.')
  })

  it('persists destructive approval before the first team write', async () => {
    const saves: CheckpointState[] = []
    const approvalHistory: CheckpointState['approvalHistory'] = []
    let approvalPersistedBeforeWrite = false
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Core', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: (team) =>
          Effect.sync(() => {
            approvalPersistedBeforeWrite =
              saves.at(-1)?.approvalHistory.some((record) => record.approved) ?? false
            return {id: 1, slug: team.slug, name: team.name, privacy: team.privacy}
          }),
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
        request: (request) =>
          Effect.sync(() => {
            approvalHistory.push({
              action: request.action,
              context: JSON.stringify(request.context),
              approved: true,
              timestamp: '2026-07-28T00:00:00.000Z',
            })
            return true
          }),
        history: Effect.sync(() => [...approvalHistory]),
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
        apply: true,
        concurrency: 1,
      }).pipe(Effect.provide(layer)),
    )

    expect(approvalPersistedBeforeWrite).toBe(true)
  })

  it('rejects an incompatible checkpoint before calling external services', async () => {
    const saves: CheckpointState[] = []
    const getTeams = vi.fn(() => Effect.succeed([]))
    const loadedState: CheckpointState = {
      schemaVersion: 1,
      runId: 'run-other-scope',
      timestamp: '2026-07-28T00:00:00.000Z',
      adoOrg: 'https://dev.azure.com/other',
      adoProject: 'Other',
      githubOrg: 'other',
      migrationConfig: {
        apply: true,
        prefix: '',
        suffix: '',
      },
      phase: 'fetch',
      completedTeams: [],
      completedMemberPairs: [],
      pendingTeams: [],
      mappings: [],
      edgeCases: [],
      skippedItems: [],
      failureLog: [],
      approvalHistory: [],
    }
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams,
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({id: 1, slug: 'unused', name: 'Unused', privacy: 'closed'}),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: () => Effect.succeed([]),
        resolveUserByUpn: () => Effect.succeed(null),
      }),
      checkpointLayer(saves, loadedState),
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
          apply: true,
          concurrency: 1,
          resume: loadedState.runId,
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('is incompatible with the requested migration scope')
    expect(getTeams).not.toHaveBeenCalled()
  })
})
