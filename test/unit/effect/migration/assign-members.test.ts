import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {ValidationFailure} from '../../../../src/effect/errors.js'
import {assignMembers} from '../../../../src/effect/migration/assign-members.js'
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

    expect(events).toEqual([
      'save:0',
      'save:0',
      'assign:platform:ada',
      'save:1',
    ])
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
})
