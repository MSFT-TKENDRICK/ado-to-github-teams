import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {TransientFailure} from '../../../../src/effect/errors.js'
import {createTeams} from '../../../../src/effect/migration/create-teams.js'
import type {ApprovalRecord, ApprovalRequest} from '../../../../src/types/index.js'
import {mappingLayer} from './test-layers.js'
import {checkpointState, memoryStateStore} from './test-state.js'

describe('createTeams', () => {
  it('checkpoints approval before the first write and records completion after it', async () => {
    const events: string[] = []
    const requests: ApprovalRequest[] = []
    const history: ApprovalRecord[] = []
    const memory = memoryStateStore(checkpointState(), (state) => {
      events.push(`save:${state.approvalHistory.length}:${state.completedTeams.length}`)
    })

    const skipped = await Effect.runPromise(
      createTeams(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            approval: {
              request: (request) =>
                Effect.sync(() => {
                  requests.push(request)
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
              createTeam: (team) =>
                Effect.sync(() => {
                  events.push(`create:${team.slug}`)
                  return team
                }),
            },
          }),
        ),
      ),
    )

    expect(skipped).toEqual([])
    expect(requests[0]?.displayLines).toEqual([
      JSON.stringify(checkpointState().mappings[0]?.githubTeam),
    ])
    expect(events).toEqual([
      'save:1:0',
      'save:1:0',
      'create:platform',
      'save:1:1',
    ])
    expect(memory.state().completedTeams).toEqual(['platform'])
  })

  it('treats an identical existing team as an idempotent completion', async () => {
    let creates = 0
    const memory = memoryStateStore(checkpointState())

    await Effect.runPromise(
      createTeams(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            github: {
              getTeamBySlug: () =>
                Effect.succeed({
                  id: 42,
                  slug: 'platform',
                  name: 'Platform',
                  privacy: 'closed',
                }),
              createTeam: (team) =>
                Effect.sync(() => {
                  creates += 1
                  return team
                }),
            },
          }),
        ),
      ),
    )

    expect(creates).toBe(0)
    expect(memory.state().completedTeams).toEqual(['platform'])
  })

  it('reconciles a lost create response on resume without repeating the POST', async () => {
    let exists = false
    let creates = 0
    const memory = memoryStateStore(checkpointState())
    const layer = mappingLayer({
      github: {
        getTeamBySlug: () =>
          Effect.succeed(
            exists
              ? {
                  id: 42,
                  slug: 'platform',
                  name: 'Platform',
                  privacy: 'closed',
                }
              : null,
          ),
        createTeam: () =>
          Effect.suspend(() => {
            creates += 1
            exists = true
            return Effect.fail(
              new TransientFailure({
                service: 'github',
                message: 'Response lost after commit',
              }),
            )
          }),
      },
    })

    await expect(
      Effect.runPromise(createTeams(memory.store).pipe(Effect.provide(layer))),
    ).rejects.toThrow('Response lost after commit')
    expect(creates).toBe(1)
    expect(memory.state().completedTeams).toEqual([])

    await Effect.runPromise(createTeams(memory.store).pipe(Effect.provide(layer)))

    expect(creates).toBe(1)
    expect(memory.state().completedTeams).toEqual(['platform'])
  })
})
