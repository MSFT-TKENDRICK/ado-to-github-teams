import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {TransientFailure} from '../../../../src/effect/errors.js'
import {grantRepositories} from '../../../../src/effect/migration/grant-repositories.js'
import type {ApprovalRecord} from '../../../../src/types/index.js'
import {mappingLayer} from './test-layers.js'
import {checkpointState, memoryStateStore} from './test-state.js'

const grant = {
  repository: 'contoso/api',
  teamSlug: 'api-contributors',
  role: 'write' as const,
  basePermission: 'none' as const,
  visibility: 'private' as const,
}

describe('grantRepositories', () => {
  it('records approval before applying and checkpoints the completed grant', async () => {
    const events: string[] = []
    const history: ApprovalRecord[] = []
    const memory = memoryStateStore(
      checkpointState({
        phase: 'grant-repositories',
        repositoryGrants: [grant],
        completedRepositoryGrants: [],
      }),
      (state) => events.push(`save:${state.completedRepositoryGrants?.length ?? 0}`),
    )

    await Effect.runPromise(
      grantRepositories(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            approval: {
              request: (request) =>
                Effect.sync(() => {
                  history.push({
                    action: request.action,
                    context: JSON.stringify(request.context),
                    approved: true,
                    timestamp: '2026-01-01T00:00:00.000Z',
                  })
                  return true
                }),
              history: Effect.sync(() => [...history]),
            },
            github: {
              setTeamRepositoryPermission: (team, repository, role) =>
                Effect.sync(() => events.push(`grant:${team}:${repository}:${role}`)),
            },
          }),
        ),
      ),
    )

    expect(events).toEqual(['save:0', 'save:0', 'grant:api-contributors:contoso/api:write', 'save:1'])
    expect(memory.state().completedRepositoryGrants).toEqual([
      'api-contributors:contoso/api:write',
    ])
  })

  it('reconciles an already-applied grant without repeating the write', async () => {
    let writes = 0
    const memory = memoryStateStore(
      checkpointState({
        phase: 'grant-repositories',
        repositoryGrants: [grant],
        completedRepositoryGrants: [],
      }),
    )

    await Effect.runPromise(
      grantRepositories(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            github: {
              getTeamRepositoryPermission: () => Effect.succeed('write'),
              setTeamRepositoryPermission: () =>
                Effect.sync(() => {
                  writes += 1
                }),
            },
          }),
        ),
      ),
    )

    expect(writes).toBe(0)
    expect(memory.state().completedRepositoryGrants).toHaveLength(1)
  })

  it('rejects an unapproved repository grant', async () => {
    let writes = 0
    const memory = memoryStateStore(
      checkpointState({
        phase: 'grant-repositories',
        repositoryGrants: [grant],
        completedRepositoryGrants: [],
      }),
    )

    const result = await Effect.runPromise(
      Effect.either(
        grantRepositories(memory.store).pipe(
          Effect.provide(
            mappingLayer({
              approval: {request: () => Effect.succeed(false)},
              github: {
                setTeamRepositoryPermission: () =>
                  Effect.sync(() => {
                    writes += 1
                  }),
              },
            }),
          ),
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    expect(writes).toBe(0)
  })

  it('refuses to downgrade an existing stronger grant', async () => {
    const memory = memoryStateStore(
      checkpointState({
        phase: 'grant-repositories',
        repositoryGrants: [grant],
        completedRepositoryGrants: [],
      }),
    )
    const result = await Effect.runPromise(
      Effect.either(
        grantRepositories(memory.store).pipe(
          Effect.provide(
            mappingLayer({
              github: {
                getTeamRepositoryPermission: () => Effect.succeed('admin'),
              },
            }),
          ),
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('Refusing to downgrade')
    }
  })

  it('rejects a repository that changed after preflight before approval or write', async () => {
    let approvals = 0
    let writes = 0
    const memory = memoryStateStore(
      checkpointState({
        phase: 'grant-repositories',
        repositoryGrants: [grant],
        completedRepositoryGrants: [],
      }),
    )
    const result = await Effect.runPromise(
      Effect.either(
        grantRepositories(memory.store).pipe(
          Effect.provide(
            mappingLayer({
              approval: {
                request: () =>
                  Effect.sync(() => {
                    approvals += 1
                    return true
                  }),
              },
              github: {
                getRepository: (repository) =>
                  Effect.succeed({
                    fullName: repository,
                    archived: true,
                    visibility: 'private',
                  }),
                setTeamRepositoryPermission: () =>
                  Effect.sync(() => {
                    writes += 1
                  }),
              },
            }),
          ),
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    expect(approvals).toBe(0)
    expect(writes).toBe(0)
  })

  it('reconciles a lost successful write response on resume', async () => {
    let current: 'write' | null = null
    let writes = 0
    const memory = memoryStateStore(
      checkpointState({
        phase: 'grant-repositories',
        repositoryGrants: [grant],
        completedRepositoryGrants: [],
      }),
    )
    const layer = mappingLayer({
      github: {
        getTeamRepositoryPermission: () => Effect.succeed(current),
        setTeamRepositoryPermission: () =>
          Effect.suspend(() => {
            writes += 1
            current = 'write'
            return Effect.fail(
              new TransientFailure({
                service: 'github',
                message: 'Response lost after grant committed',
              }),
            )
          }),
      },
    })

    await expect(
      Effect.runPromise(grantRepositories(memory.store).pipe(Effect.provide(layer))),
    ).rejects.toThrow('Response lost after grant committed')
    expect(writes).toBe(1)

    await Effect.runPromise(grantRepositories(memory.store).pipe(Effect.provide(layer)))

    expect(writes).toBe(1)
    expect(memory.state().completedRepositoryGrants).toHaveLength(1)
  })
})
