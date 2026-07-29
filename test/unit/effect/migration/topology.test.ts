import {describe, expect, it} from 'vitest'
import {Effect} from 'effect'
import {buildTopologyPlan} from '../../../../src/effect/migration/topology.js'
import type {AdoTeam, TeamTopologyConfig} from '../../../../src/types/index.js'

const sourceTeams: AdoTeam[] = [
  {
    id: 'contributors',
    name: 'Contributors',
    projectId: 'project-1',
    projectName: 'Platform',
  },
  {
    id: 'maintainers',
    name: 'Maintainers',
    projectId: 'project-1',
    projectName: 'Platform',
  },
]

function topology(
  overrides: Partial<TeamTopologyConfig> = {},
): TeamTopologyConfig {
  return {
    version: 1,
    organizationalUnit: {name: 'Engineering'},
    projectTeam: {name: 'Platform'},
    repositories: [
      {
        repository: 'api',
        teamName: 'API Contributors',
        sourceAdoTeams: ['Contributors', 'Maintainers'],
        role: 'write',
      },
    ],
    ...overrides,
  }
}

describe('team topology planning', () => {
  it('builds an OU, project, and repository leaf hierarchy from explicit source teams', async () => {
    const result = await Effect.runPromise(
      buildTopologyPlan(topology(), 'Platform', 'contoso', sourceTeams),
    )

    expect(result.teams.map(({kind, team, parentSlug}) => [kind, team.slug, parentSlug])).toEqual([
      ['organizational-unit', 'engineering', undefined],
      ['project', 'platform', 'engineering'],
      ['repository', 'api-contributors', 'platform'],
    ])
    expect(result.grants).toEqual([
      {
        repository: 'contoso/api',
        teamSlug: 'api-contributors',
        role: 'write',
      },
    ])
    expect(result.sourcesByLeafSlug.get('api-contributors')?.map((team) => team.id)).toEqual([
      'contributors',
      'maintainers',
    ])
  })

  it('rejects repositories outside the target organization', async () => {
    const result = await Effect.runPromise(
      Effect.either(
        buildTopologyPlan(
          topology({
            repositories: [
              {
                repository: 'other/api',
                teamName: 'API Contributors',
                sourceAdoTeams: ['Contributors'],
                role: 'read',
              },
            ],
          }),
          'Platform',
          'contoso',
          sourceTeams,
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('outside target organization')
    }
  })

  it('rejects duplicate repository mappings before any provider write', async () => {
    const duplicate = {
      repository: 'contoso/api',
      teamName: 'API Reviewers',
      sourceAdoTeams: ['Maintainers'],
      role: 'triage' as const,
    }
    const result = await Effect.runPromise(
      Effect.either(
        buildTopologyPlan(
          topology({repositories: [...topology().repositories, duplicate]}),
          'Platform',
          'contoso',
          sourceTeams,
        ),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.message).toContain('mapped more than once')
    }
  })
})
