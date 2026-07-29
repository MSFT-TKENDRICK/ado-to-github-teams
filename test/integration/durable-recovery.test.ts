import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
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
import type {CheckpointState, GitHubTeam} from '../../src/types/index.js'

describe('durable migration recovery', () => {
  it('verifies a completed write after interruption and deduplicates redelivery', async () => {
    let savedState: CheckpointState | null = null
    let remoteTeam: GitHubTeam | null = null
    let createCalls = 0
    const store: CheckpointStore = {
      save: (state) =>
        Effect.sync(() => {
          savedState = structuredClone(state)
        }),
      load: () => Effect.succeed(savedState),
      latest: Effect.succeed(savedState),
      list: Effect.succeed([]),
      delete: () => Effect.void,
    }
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([
            {
              id: 't1',
              name: 'Core',
              projectId: 'p1',
              projectName: 'Platform',
            },
          ]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(remoteTeam),
        createTeam: (team) =>
          Effect.sync(() => {
            createCalls += 1
            remoteTeam = {id: 1, ...team}
          }).pipe(Effect.zipRight(Effect.interrupt)),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: () => Effect.succeed([]),
        resolveUserByUpn: () => Effect.succeed(null),
      }),
      Layer.succeed(CheckpointStoreTag, store),
      Layer.succeed(ApprovalServiceTag, {
        request: () => Effect.succeed(true),
        history: Effect.succeed([]),
      }),
      Layer.succeed(ReportWriterTag, {
        write: () => Effect.void,
      }),
    )
    const options = {
      runId: 'durable-run',
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      apply: true,
      preserveCheckpoint: true,
      concurrency: 1,
    } as const

    await expect(
      Effect.runPromise(runEffectMigration(options).pipe(Effect.provide(layer))),
    ).rejects.toThrow()
    expect(createCalls).toBe(1)
    expect((savedState as CheckpointState | null)?.completedTeams).toEqual([])

    await Effect.runPromise(runEffectMigration(options).pipe(Effect.provide(layer)))
    await Effect.runPromise(runEffectMigration(options).pipe(Effect.provide(layer)))

    expect(createCalls).toBe(1)
    expect((savedState as CheckpointState | null)?.completedTeams).toEqual(['core'])
  })

  it('rejects a redelivery with incompatible configuration', async () => {
    let savedState: CheckpointState | null = null
    const store: CheckpointStore = {
      save: (state) =>
        Effect.sync(() => {
          savedState = structuredClone(state)
        }),
      load: () => Effect.succeed(savedState),
      latest: Effect.succeed(savedState),
      list: Effect.succeed([]),
      delete: () => Effect.void,
    }
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () => Effect.succeed([]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: () => Effect.succeed(null),
        createTeam: () =>
          Effect.succeed({
            id: 1,
            slug: 'unused',
            name: 'Unused',
            privacy: 'closed',
          }),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: () => Effect.succeed([]),
        resolveUserByUpn: () => Effect.succeed(null),
      }),
      Layer.succeed(CheckpointStoreTag, store),
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
        runId: 'durable-run',
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: false,
        preserveCheckpoint: true,
        concurrency: 1,
      }).pipe(Effect.provide(layer)),
    )

    await expect(
      Effect.runPromise(
        runEffectMigration({
          runId: 'durable-run',
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'different-org',
          apply: false,
          preserveCheckpoint: true,
          concurrency: 1,
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow('incompatible with the requested migration configuration')
  })
})
