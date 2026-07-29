import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {mapMember} from '../../../../src/effect/migration/map-member.js'
import type {AdoMember, AdoTeam} from '../../../../src/types/index.js'
import {mappingLayer} from './test-layers.js'

const team: AdoTeam = {
  id: 'team-1',
  name: 'Platform',
  projectId: 'project-1',
  projectName: 'Engineering',
}

function member(overrides: Partial<AdoMember> = {}): AdoMember {
  return {
    id: 'user-1',
    displayName: 'Ada Lovelace',
    uniqueName: 'ada@contoso.com',
    isContainer: false,
    ...overrides,
  }
}

describe('mapMember', () => {
  it('maps an Entra-backed identity to an active GitHub user', async () => {
    const result = await Effect.runPromise(
      mapMember(member(), team).pipe(
        Effect.provide(
          mappingLayer({
            entra: {
              resolveUserByUpn: () =>
                Effect.succeed({
                  id: 'entra-1',
                  displayName: 'Ada Lovelace',
                  userPrincipalName: 'ada@contoso.com',
                  mail: 'ada@contoso.com',
                  isGuest: false,
                }),
            },
            github: {
              findUserByEmail: () =>
                Effect.succeed({login: 'ada', email: 'ada@contoso.com', type: 'User'}),
            },
          }),
        ),
      ),
    )

    expect(result).toEqual({
      adoIdentity: member(),
      githubUser: {login: 'ada', email: 'ada@contoso.com', type: 'User'},
      mapped: true,
    })
  })

  it('classifies project roles without querying identity providers', async () => {
    let lookups = 0
    const role = member({
      displayName: 'Project Administrators',
      uniqueName: 'Project Administrators',
    })

    const result = await Effect.runPromise(
      mapMember(role, team).pipe(
        Effect.provide(
          mappingLayer({
            entra: {
              resolveUserByUpn: () =>
                Effect.sync(() => {
                  lookups += 1
                  return null
                }),
            },
          }),
        ),
      ),
    )

    expect(result.mapped).toBe(false)
    expect(result.edgeCase?.reason).toBe('ado-project-role')
    expect(lookups).toBe(0)
  })

  it('reports a missing GHEMU account as an edge case', async () => {
    const result = await Effect.runPromise(
      mapMember(member(), team).pipe(
        Effect.provide(
          mappingLayer({
            entra: {
              resolveUserByUpn: () =>
                Effect.succeed({
                  id: 'entra-1',
                  displayName: 'Ada Lovelace',
                  userPrincipalName: 'ada@contoso.com',
                  isGuest: false,
                }),
            },
          }),
        ),
      ),
    )

    expect(result.mapped).toBe(false)
    expect(result.edgeCase?.reason).toBe('no-ghemu-account')
  })
})
