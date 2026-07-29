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

function memoryStore(): {
  store: CheckpointStore
  latest: () => CheckpointState | null
} {
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
  return {store, latest: () => savedState}
}

const OPTIONS = {
  runId: 'batch-run',
  adoOrg: 'https://dev.azure.com/contoso',
  adoProject: 'Platform',
  githubOrg: 'contoso',
  apply: true,
  preserveCheckpoint: true,
  concurrency: 1,
} as const

describe('bounded apply batches', () => {
  it('stops at a checkpoint boundary when the batch budget is exhausted and resumes the remainder', async () => {
    const remote = new Map<string, GitHubTeam>()
    let createCalls = 0
    const {store, latest} = memoryStore()
    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([
            {id: 't1', name: 'Core', projectId: 'p1', projectName: 'Platform'},
            {
              id: 't2',
              name: 'Payments',
              projectId: 'p1',
              projectName: 'Platform',
            },
          ]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: (slug) => Effect.succeed(remote.get(slug) ?? null),
        createTeam: (team) =>
          Effect.sync(() => {
            createCalls += 1
            const created: GitHubTeam = {id: createCalls, ...team}
            remote.set(team.slug, created)
            return created
          }),
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
        isTeamIdpManaged: () => Effect.succeed(false),
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
      Layer.succeed(ReportWriterTag, {write: () => Effect.void}),
    )
    const options = {...OPTIONS, applyBatch: {maxUnits: 1}} as const

    const first = await Effect.runPromise(runEffectMigration(options).pipe(Effect.provide(layer)))
    expect(first.pendingWork).toBe(true)
    expect(createCalls).toBe(1)
    expect(latest()?.completedTeams).toEqual(['core'])
    expect(latest()?.phase).toBe('create-teams')

    const second = await Effect.runPromise(runEffectMigration(options).pipe(Effect.provide(layer)))
    expect(second.pendingWork).toBeFalsy()
    expect(createCalls).toBe(2)
    expect(latest()?.completedTeams).toEqual(['core', 'payments'])
  })

  it('flushes the checkpoint on cancellation and does not duplicate a lost side-effect acknowledgement', async () => {
    const remote = new Map<string, GitHubTeam>()
    let createCalls = 0
    const {store, latest} = memoryStore()
    const gitHub = (interrupt: boolean) =>
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: (slug) => Effect.succeed(remote.get(slug) ?? null),
        createTeam: (team) => {
          const write = Effect.sync(() => {
            createCalls += 1
            const created: GitHubTeam = {id: createCalls, ...team}
            remote.set(team.slug, created)
            return created
          })
          // Simulate a crash after the remote write succeeds but before its
          // acknowledgement is checkpointed: the side effect happened, the ack
          // is lost.
          return interrupt ? write.pipe(Effect.zipRight(Effect.interrupt)) : write
        },
        addTeamMember: () => Effect.void,
        findUserByEmail: () => Effect.succeed(null),
        isUserSuspended: () => Effect.succeed(false),
        isTeamIdpManaged: () => Effect.succeed(false),
      })
    const baseLayer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.succeed([{id: 't1', name: 'Core', projectId: 'p1', projectName: 'Platform'}]),
        getTeamMembers: () => Effect.succeed([]),
        resolveGroupOriginId: () => Effect.succeed(null),
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
      Layer.succeed(ReportWriterTag, {write: () => Effect.void}),
    )

    await expect(
      Effect.runPromise(
        runEffectMigration(OPTIONS).pipe(Effect.provide(Layer.mergeAll(baseLayer, gitHub(true)))),
      ),
    ).rejects.toThrow()
    // The remote side effect happened but the completion ack was never recorded.
    expect(createCalls).toBe(1)
    expect(remote.has('core')).toBe(true)
    expect(latest()?.completedTeams).toEqual([])

    // Redelivery verifies the slug before writing, so it does not duplicate.
    await Effect.runPromise(
      runEffectMigration(OPTIONS).pipe(Effect.provide(Layer.mergeAll(baseLayer, gitHub(false)))),
    )
    expect(createCalls).toBe(1)
    expect(latest()?.completedTeams).toEqual(['core'])
  })
})
