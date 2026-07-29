import {describe, expect, it} from 'vitest'
import {Effect, Layer} from 'effect'
import {
  TransientFailure,
  ValidationFailure,
} from '../../../../src/effect/errors.js'
import {createTeams} from '../../../../src/effect/migration/create-teams.js'
import {HealingReasonerTag} from '../../../../src/effect/services.js'
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

  it('creates hierarchy parents before children and passes the resolved parent id', async () => {
    const created = new Map<string, {id: number; slug: string; name: string; privacy: 'closed'; parentTeam?: {id: number; slug: string}}>()
    const calls: string[] = []
    const memory = memoryStateStore(
      checkpointState({
        mappings: [],
        teamPlan: [
          {
            team: {slug: 'engineering', name: 'Engineering', privacy: 'closed'},
            kind: 'organizational-unit',
            sourceAdoTeamIds: [],
          },
          {
            team: {slug: 'platform', name: 'Platform', privacy: 'closed'},
            kind: 'project',
            parentSlug: 'engineering',
            sourceAdoTeamIds: [],
          },
        ],
      }),
    )

    await Effect.runPromise(
      createTeams(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            github: {
              getTeamBySlug: (slug) => Effect.succeed(created.get(slug) ?? null),
              createTeam: (team) =>
                Effect.sync(() => {
                  calls.push(`${team.slug}:${team.parentTeamId ?? 'root'}`)
                  const parent =
                    team.parentTeamId === undefined
                      ? undefined
                      : {id: team.parentTeamId, slug: 'engineering'}
                  const result = {
                    id: created.size + 1,
                    slug: team.slug,
                    name: team.name,
                    privacy: 'closed' as const,
                    ...(parent ? {parentTeam: parent} : {}),
                  }
                  created.set(team.slug, result)
                  return result
                }),
            },
          }),
        ),
      ),
    )

    expect(calls).toEqual(['engineering:root', 'platform:1'])
    expect(memory.state().completedTeams).toEqual(['engineering', 'platform'])
  })

  it('requires operator approval before applying an inferred team skip', async () => {
    const approvals: string[] = []
    const memory = memoryStateStore(checkpointState())
    const layer = Layer.mergeAll(
      mappingLayer({
        approval: {
          request: (request) =>
            Effect.sync(() => {
              approvals.push(request.action)
              return true
            }),
        },
        github: {
          createTeam: () =>
            Effect.fail(
              new ValidationFailure({
                service: 'github',
                message: 'Team settings are invalid',
                status: 422,
              }),
            ),
        },
      }),
      Layer.succeed(HealingReasonerTag, {
        assess: () =>
          Effect.succeed({
            action: 'skip',
            confidence: 0.99,
            safeToAutomate: true,
            rationale: 'The invalid team needs manual correction.',
            risk: 'The team will be omitted from this run.',
            prerequisites: ['Review the desired team settings.'],
          }),
      }),
    )

    const skipped = await Effect.runPromise(
      createTeams(memory.store).pipe(Effect.provide(layer)),
    )

    expect(approvals).toEqual([
      'Create 1 teams in contoso',
      'Skip failed create-team per Copilot recommendation',
    ])
    expect(skipped).toEqual([
      {
        type: 'team',
        name: 'Platform',
        reason: 'Team settings are invalid',
      },
    ])
    expect(memory.state().completedTeams).toEqual([])
  })

  it('never automatically retries an ambiguous team creation', async () => {
    let creates = 0
    const approvals: string[] = []
    const memory = memoryStateStore(checkpointState())
    const layer = Layer.mergeAll(
      mappingLayer({
        approval: {
          request: (request) =>
            Effect.sync(() => {
              approvals.push(request.action)
              return true
            }),
        },
        github: {
          createTeam: () =>
            Effect.sync(() => {
              creates += 1
            }).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new TransientFailure({
                    service: 'github',
                    message: 'Response lost after commit',
                    status: 503,
                  }),
                ),
              ),
            ),
        },
      }),
      Layer.succeed(HealingReasonerTag, {
        assess: () =>
          Effect.succeed({
            action: 'retry',
            confidence: 0.99,
            safeToAutomate: true,
            rationale: 'Retry the failed write.',
            risk: 'The first POST may have completed.',
            prerequisites: ['Verify whether the team exists.'],
          }),
      }),
    )

    const skipped = await Effect.runPromise(
      createTeams(memory.store).pipe(Effect.provide(layer)),
    )

    expect(creates).toBe(1)
    expect(approvals).toEqual([
      'Create 1 teams in contoso',
      'Skip failed create-team; the recommended retry is not permitted',
    ])
    expect(skipped).toEqual([
      {
        type: 'team',
        name: 'Platform',
        reason: 'Response lost after commit',
      },
    ])
  })
})
