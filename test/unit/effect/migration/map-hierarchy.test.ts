import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {mapHierarchy} from '../../../../src/effect/migration/map-teams.js'
import type {AdoTeam, TeamTopologyConfig} from '../../../../src/types/index.js'
import {mappingLayer} from './test-layers.js'

const teams: AdoTeam[] = [
  {
    id: 'contributors',
    name: 'Contributors',
    projectId: 'project-1',
    projectName: 'Platform',
  },
]

const config: TeamTopologyConfig = {
  version: 1,
  organizationalUnit: {name: 'Engineering'},
  repositories: [
    {
      repository: 'api',
      teamName: 'API Contributors',
      sourceAdoTeams: ['Contributors'],
      role: 'write',
    },
  ],
}

const options = {
  adoOrg: 'https://dev.azure.com/contoso',
  adoProject: 'Platform',
  githubOrg: 'contoso',
  apply: false,
  concurrency: 2,
  topology: {config, digest: 'digest', sourcePath: 'topology.yaml'},
} as const

describe('mapHierarchy', () => {
  it('maps source membership only into repository leaf teams', async () => {
    const result = await Effect.runPromise(
      mapHierarchy(teams, options).pipe(
        Effect.provide(
          mappingLayer({
            ado: {
              getTeamMembers: () =>
                Effect.succeed([
                  {
                    id: 'user-1',
                    displayName: 'Ada',
                    uniqueName: 'ada@contoso.com',
                    isContainer: false,
                  },
                ]),
            },
            entra: {
              resolveUserByUpn: () =>
                Effect.succeed({
                  id: 'entra-1',
                  displayName: 'Ada',
                  userPrincipalName: 'ada@contoso.com',
                  mail: 'ada@contoso.com',
                  accountEnabled: true,
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

    expect(result.teamPlan.map((planned) => planned.kind)).toEqual([
      'organizational-unit',
      'project',
      'repository',
    ])
    expect(result.mappings).toHaveLength(1)
    expect(result.mappings[0]?.githubTeam.slug).toBe('api-contributors')
    expect(result.mappings[0]?.memberMappings[0]?.githubUser?.login).toBe('ada')
    expect(result.repositoryGrants[0]).toMatchObject({
      repository: 'contoso/api',
      teamSlug: 'api-contributors',
      role: 'write',
      basePermission: 'none',
    })
  })

  it('fails when organization base access exceeds the proposed leaf grant', async () => {
    const readOptions = {
      ...options,
      topology: {
        ...options.topology,
        config: {
          ...config,
          repositories: [{...config.repositories[0]!, role: 'read' as const}],
        },
      },
    }
    const result = await Effect.runPromise(
      Effect.either(
        mapHierarchy(teams, readOptions).pipe(
          Effect.provide(
            mappingLayer({
              github: {
                getOrganizationBasePermission: () => Effect.succeed('write'),
              },
            }),
          ),
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('base permission write exceeds proposed read')
    }
  })

  it('rejects an existing IdP-managed structural team', async () => {
    const result = await Effect.runPromise(
      Effect.either(
        mapHierarchy(teams, options).pipe(
          Effect.provide(
            mappingLayer({
              github: {
                getTeamBySlug: (slug) =>
                  Effect.succeed(
                    slug === 'engineering'
                      ? {id: 1, slug, name: 'Engineering', privacy: 'closed'}
                      : null,
                  ),
                isTeamIdpManaged: () => Effect.succeed(true),
              },
            }),
          ),
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('managed by an identity provider')
    }
  })

  it('rejects inherited access from an existing structural parent', async () => {
    const result = await Effect.runPromise(
      Effect.either(
        mapHierarchy(teams, options).pipe(
          Effect.provide(
            mappingLayer({
              github: {
                getTeamBySlug: (slug) =>
                  Effect.succeed(
                    slug === 'engineering'
                      ? {id: 1, slug, name: 'Engineering', privacy: 'closed'}
                      : null,
                  ),
                listTeamRepositories: () => Effect.succeed(['contoso/legacy']),
              },
            }),
          ),
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('descendants would inherit it')
    }
  })

  it('rejects an unsupported re-parenting combination for an existing team', async () => {
    // Nested GitHub org teams and Entra/SCIM-managed teams are not always
    // compatible: an existing team parented under a different team than the
    // plan requires manual review rather than a silent move.
    const reparentResult = await Effect.runPromise(
      Effect.either(
        mapHierarchy(teams, options).pipe(
          Effect.provide(
            mappingLayer({
              github: {
                getTeamBySlug: (slug) =>
                  Effect.succeed(
                    slug === 'api-contributors'
                      ? {
                          id: 3,
                          slug,
                          name: 'API Contributors',
                          privacy: 'closed',
                          parentTeam: {id: 999, slug: 'some-other-team'},
                        }
                      : null,
                  ),
              },
            }),
          ),
        ),
      ),
    )

    expect(reparentResult._tag).toBe('Left')
    if (reparentResult._tag === 'Left') {
      expect(reparentResult.left.message).toContain('has parent some-other-team; expected platform')
      expect(reparentResult.left.message).toContain('Re-parenting requires manual review')
    }
  })
})
