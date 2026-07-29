import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {ValidationFailure} from '../../../../src/effect/errors.js'
import {mapTeam} from '../../../../src/effect/migration/map-team.js'
import type {AdoMember, AdoTeam} from '../../../../src/types/index.js'
import {mappingLayer} from './test-layers.js'

const team: AdoTeam = {
  id: 'team-1',
  name: 'Platform',
  description: 'Platform engineering',
  projectId: 'project-1',
  projectName: 'Engineering',
}

const group: AdoMember = {
  id: 'ado-group',
  descriptor: 'vssgp.group',
  displayName: 'Platform Contributors',
  uniqueName: 'Platform Contributors',
  isContainer: true,
}

describe('mapTeam', () => {
  it('expands an ADO container through its Entra origin id', async () => {
    const requestedGroups: string[] = []
    const result = await Effect.runPromise(
      mapTeam(team, [group], {prefix: 'gh-', suffix: '-team', concurrency: 2}).pipe(
        Effect.provide(
          mappingLayer({
            ado: {
              resolveGroupOriginId: () => Effect.succeed('entra-group'),
            },
            entra: {
              getGroupMembers: (groupId) =>
                Effect.sync(() => {
                  requestedGroups.push(groupId)
                  return [
                    {
                      id: 'entra-user',
                      displayName: 'Ada Lovelace',
                      userPrincipalName: 'ada@contoso.com',
                      mail: 'ada@contoso.com',
                      isGuest: false,
                    },
                  ]
                }),
              resolveUserByUpn: () =>
                Effect.succeed({
                  id: 'entra-user',
                  displayName: 'Ada Lovelace',
                  userPrincipalName: 'ada@contoso.com',
                  mail: 'ada@contoso.com',
                  isGuest: false,
                }),
            },
            github: {
              findUserByEmail: () => Effect.succeed({login: 'ada', type: 'User'}),
            },
          }),
        ),
      ),
    )

    expect(requestedGroups).toEqual(['entra-group'])
    expect(result.githubTeam).toEqual({
      slug: 'gh-platform-team',
      name: 'gh-Platform-team',
      description: 'Platform engineering',
      privacy: 'closed',
    })
    expect(result.memberMappings.map((mapping) => mapping.githubUser?.login)).toEqual(['ada'])
  })

  it('turns circular group expansion into a team edge case', async () => {
    const result = await Effect.runPromise(
      mapTeam(team, [group], {concurrency: 1}).pipe(
        Effect.provide(
          mappingLayer({
            ado: {
              resolveGroupOriginId: () => Effect.succeed('entra-group'),
            },
            entra: {
              getGroupMembers: () =>
                Effect.fail(
                  new ValidationFailure({
                    service: 'entra',
                    message: 'Circular group membership detected',
                  }),
                ),
            },
          }),
        ),
      ),
    )

    expect(result.memberMappings).toEqual([])
    expect(result.edgeCases.map((edgeCase) => edgeCase.reason)).toEqual(['circular-group-member'])
  })

  it('fails closed when a proposed conflict resolution is rejected', async () => {
    const program = mapTeam(team, [], {concurrency: 1}).pipe(
      Effect.provide(
        mappingLayer({
          github: {
            getTeamBySlug: () =>
              Effect.succeed({id: 1, slug: 'platform', name: 'Other', privacy: 'closed'}),
          },
          approval: {
            request: () => Effect.succeed(false),
          },
        }),
      ),
    )

    const result = await Effect.runPromise(Effect.either(program))

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left._tag).toBe('ApprovalRejected')
    }
  })
})
