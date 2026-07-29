import {describe, expect, it} from 'vitest'
import {Effect, Layer} from 'effect'
import {TransientFailure, ValidationFailure} from '../../../../src/effect/errors.js'
import {assignMembers} from '../../../../src/effect/migration/assign-members.js'
import {HealingReasonerTag} from '../../../../src/effect/services.js'
import {mappingLayer} from './test-layers.js'
import {checkpointState, mapping, memoryStateStore} from './test-state.js'

describe('assignMembers', () => {
  it('deduplicates assignments and checkpoints each idempotent write', async () => {
    const events: string[] = []
    const duplicateMapping = {
      ...mapping,
      memberMappings: [...mapping.memberMappings, ...mapping.memberMappings],
    }
    const memory = memoryStateStore(
      checkpointState({
        phase: 'assign-members',
        completedTeams: ['platform'],
        mappings: [duplicateMapping],
      }),
      (state) => {
        events.push(`save:${state.completedMemberPairs.length}`)
      },
    )

    await Effect.runPromise(
      assignMembers(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            github: {
              addTeamMember: (slug, login) =>
                Effect.sync(() => {
                  events.push(`assign:${slug}:${login}`)
                }),
            },
          }),
        ),
      ),
    )

    expect(events).toEqual(['save:0', 'save:0', 'assign:platform:ada', 'save:1'])
    expect(memory.state().completedMemberPairs).toEqual(['platform:ada'])
  })

  it('returns a validation skip while retaining its failure checkpoint', async () => {
    const memory = memoryStateStore(
      checkpointState({phase: 'assign-members', completedTeams: ['platform']}),
    )

    const skipped = await Effect.runPromise(
      assignMembers(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            github: {
              addTeamMember: () =>
                Effect.fail(
                  new ValidationFailure({
                    service: 'github',
                    message: 'User cannot be assigned',
                    status: 422,
                  }),
                ),
            },
          }),
        ),
      ),
    )

    expect(skipped).toEqual([
      {
        type: 'member',
        name: 'platform:ada',
        reason: 'User cannot be assigned',
      },
    ])
    expect(memory.state().failureLog).toHaveLength(1)
  })

  it('automatically retries once when Copilot marks an idempotent write safe', async () => {
    let attempts = 0
    const memory = memoryStateStore(
      checkpointState({phase: 'assign-members', completedTeams: ['platform']}),
    )
    const layer = Layer.mergeAll(
      mappingLayer({
        github: {
          addTeamMember: () =>
            Effect.suspend(() => {
              attempts += 1
              return attempts === 1
                ? Effect.fail(
                    new TransientFailure({
                      service: 'github',
                      message: 'Request timed out',
                      status: 503,
                    }),
                  )
                : Effect.void
            }),
        },
      }),
      Layer.succeed(HealingReasonerTag, {
        assess: () =>
          Effect.succeed({
            action: 'retry',
            confidence: 0.97,
            safeToAutomate: true,
            rationale: 'The membership PUT is idempotent and checkpointed.',
            risk: 'The first request may have completed.',
            prerequisites: ['Verify membership before the retry.'],
          }),
      }),
    )

    await Effect.runPromise(assignMembers(memory.store).pipe(Effect.provide(layer)))

    expect(attempts).toBe(2)
    expect(memory.state().completedMemberPairs).toEqual(['platform:ada'])
    expect(memory.state().failureLog).toEqual([
      expect.objectContaining({
        healingAction: 'Recorded member add failure',
        resolved: false,
      }),
      expect.objectContaining({
        healingAction: expect.stringContaining('bounded retry'),
        automaticRetry: true,
        target: 'platform:ada',
        resolved: true,
      }),
    ])
  })

  it('does not automatically retry a failed unit more than once', async () => {
    let attempts = 0
    const approvals: string[] = []
    const memory = memoryStateStore(
      checkpointState({phase: 'assign-members', completedTeams: ['platform']}),
    )
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
          addTeamMember: () =>
            Effect.sync(() => {
              attempts += 1
            }).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new TransientFailure({
                    service: 'github',
                    message: 'Request timed out',
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
            rationale: 'Retry the membership PUT.',
            risk: 'The provider may remain unavailable.',
            prerequisites: ['Keep the retry bounded.'],
          }),
      }),
    )

    const skipped = await Effect.runPromise(assignMembers(memory.store).pipe(Effect.provide(layer)))

    expect(attempts).toBe(2)
    expect(approvals).toEqual([
      'Add 1 members across 1 teams',
      'Skip failed assign-member; the recommended retry is not permitted',
    ])
    expect(skipped).toEqual([
      {
        type: 'member',
        name: 'platform:ada',
        reason: 'Request timed out',
      },
    ])
    expect(memory.state().failureLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          automaticRetry: true,
          target: 'platform:ada',
          resolved: false,
        }),
      ]),
    )
  })

  it.each([
    {confidence: 0.5, safeToAutomate: true},
    {confidence: 0.99, safeToAutomate: false},
  ])(
    'requires approval when retry confidence is $confidence and safeToAutomate is $safeToAutomate',
    async ({confidence, safeToAutomate}) => {
      let attempts = 0
      const approvals: string[] = []
      const memory = memoryStateStore(
        checkpointState({phase: 'assign-members', completedTeams: ['platform']}),
      )
      const layer = Layer.mergeAll(
        mappingLayer({
          approval: {
            request: (request) =>
              Effect.sync(() => {
                approvals.push(request.action)
                return approvals.length === 1
              }),
          },
          github: {
            addTeamMember: () =>
              Effect.suspend(() => {
                attempts += 1
                return Effect.fail(
                  new TransientFailure({
                    service: 'github',
                    message: 'Request timed out',
                    status: 503,
                  }),
                )
              }),
          },
        }),
        Layer.succeed(HealingReasonerTag, {
          assess: () =>
            Effect.succeed({
              action: 'retry',
              confidence,
              safeToAutomate,
              rationale: 'Retry the membership PUT.',
              risk: 'The provider may remain unavailable.',
              prerequisites: ['Obtain operator approval.'],
            }),
        }),
      )

      await expect(
        Effect.runPromise(assignMembers(memory.store).pipe(Effect.provide(layer))),
      ).rejects.toThrow('Request timed out')

      expect(attempts).toBe(1)
      expect(approvals).toEqual([
        'Add 1 members across 1 teams',
        'Retry failed assign-member per Copilot recommendation',
      ])
    },
  )

  it('fails closed when the GitHub adapter cannot detect IdP-managed teams', async () => {
    const memory = memoryStateStore(
      checkpointState({phase: 'assign-members', completedTeams: ['platform']}),
    )

    const failure = await Effect.runPromise(
      assignMembers(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            github: {
              // Explicitly undefined (not omitted): simulates an adapter build
              // that doesn't implement the safety check, overriding the
              // default stub rather than merely leaving it unset.
              isTeamIdpManaged: undefined,
            },
          }),
        ),
        Effect.flip,
      ),
    )

    expect(failure).toBeInstanceOf(ValidationFailure)
    expect(failure.message).toContain('isTeamIdpManaged')
    expect(memory.state().completedMemberPairs).toEqual([])
  })

  it('skips membership writes to an IdP-managed team without proposing or writing them', async () => {
    let addCalls = 0
    const memory = memoryStateStore(
      checkpointState({phase: 'assign-members', completedTeams: ['platform']}),
    )
    const approvals: Array<{action: string; memberCount: number}> = []

    const skipped = await Effect.runPromise(
      assignMembers(memory.store).pipe(
        Effect.provide(
          mappingLayer({
            approval: {
              request: (request) =>
                Effect.sync(() => {
                  approvals.push({
                    action: request.action,
                    memberCount: (request.context as {memberCount: number}).memberCount,
                  })
                  return true
                }),
            },
            github: {
              isTeamIdpManaged: () => Effect.succeed(true),
              addTeamMember: () =>
                Effect.sync(() => {
                  addCalls += 1
                }),
            },
          }),
        ),
      ),
    )

    expect(addCalls).toBe(0)
    expect(skipped).toEqual([
      {
        type: 'member',
        name: 'platform:ada',
        reason:
          'Team platform is synchronized by an identity provider (SCIM/team-sync); membership for ada must not be written by this tool.',
      },
    ])
    // The approval request must reflect zero writable members: the IdP-managed
    // team was removed from the proposal before the operator was ever asked.
    expect(approvals).toEqual([{action: 'Add 0 members across 1 teams', memberCount: 0}])
    const finalState = memory.state()
    expect(finalState.completedMemberPairs).toEqual([])
    expect(finalState.skippedItems).toEqual([
      {
        type: 'member',
        name: 'platform:ada',
        reason:
          'Team platform is synchronized by an identity provider (SCIM/team-sync); membership for ada must not be written by this tool.',
      },
    ])
    expect(finalState.edgeCases).toEqual([expect.objectContaining({reason: 'idp-managed-team'})])
  })

  it('persists the IdP-managed skip before resume so a re-run cannot bypass it', async () => {
    let addCalls = 0
    let idpCheckCalls = 0
    const memory = memoryStateStore(
      checkpointState({phase: 'assign-members', completedTeams: ['platform']}),
    )
    const layer = () =>
      mappingLayer({
        github: {
          isTeamIdpManaged: () =>
            Effect.sync(() => {
              idpCheckCalls += 1
              return true
            }),
          addTeamMember: () =>
            Effect.sync(() => {
              addCalls += 1
            }),
        },
      })

    await Effect.runPromise(assignMembers(memory.store).pipe(Effect.provide(layer())))
    expect(idpCheckCalls).toBe(1)
    expect(addCalls).toBe(0)
    expect(memory.state().skippedItems).toHaveLength(1)

    // Simulate a resumed run against the persisted checkpoint state. The prior
    // skip decision must be re-derived from state, not bypassed or re-prompted.
    const resumedSkipped = await Effect.runPromise(
      assignMembers(memory.store).pipe(Effect.provide(layer())),
    )

    expect(resumedSkipped).toEqual([])
    expect(addCalls).toBe(0)
    // The candidate is already excluded via skippedItems, so a resume does not
    // need to re-invoke isTeamIdpManaged for it.
    expect(idpCheckCalls).toBe(1)
    expect(memory.state().skippedItems).toHaveLength(1)
  })
})
