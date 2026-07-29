import {describe, expect, it, vi} from 'vitest'
import {GitHubService} from '../../../src/services/github.js'
import {HttpStatusError, ValidationError} from '../../../src/utils/errors.js'

describe('GitHubService.createTeam', () => {
  it('fails when an existing slug belongs to a different team name', async () => {
    const service = new GitHubService('token', 'contoso')
    vi.spyOn(service, 'getTeamBySlug').mockResolvedValue({
      id: 7,
      slug: 'platform-team',
      name: 'Platform Operations',
      privacy: 'closed',
    })

    await expect(
      service.createTeam({
        slug: 'platform-team',
        name: 'Platform Team',
        privacy: 'closed',
      }),
    ).rejects.toBeInstanceOf(HttpStatusError)

    await expect(
      service.createTeam({
        slug: 'platform-team',
        name: 'Platform Team',
        privacy: 'closed',
      }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'GitHub team slug platform-team already exists for Platform Operations; expected Platform Team',
    })
  })

  it('does not repeat an unverified team creation POST', async () => {
    const service = new GitHubService('token', 'contoso')
    vi.spyOn(service, 'getTeamBySlug').mockResolvedValue(null)
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('unavailable'), {status: 503}))
    ;(
      service as unknown as {
        octokit: {rest: {teams: {create: typeof create}}}
      }
    ).octokit = {rest: {teams: {create}}}

    await expect(
      service.createTeam({
        slug: 'platform-team',
        name: 'Platform Team',
        privacy: 'closed',
      }),
    ).rejects.toMatchObject({status: 503})
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('creates a child team with the requested parent id', async () => {
    const service = new GitHubService('token', 'contoso')
    vi.spyOn(service, 'getTeamBySlug').mockResolvedValue(null)
    const create = vi.fn().mockResolvedValue({
      data: {
        id: 8,
        slug: 'platform',
        name: 'Platform',
        privacy: 'closed',
        description: null,
        parent: {id: 7, slug: 'engineering'},
      },
    })
    ;(
      service as unknown as {
        octokit: {rest: {teams: {create: typeof create}}}
      }
    ).octokit = {rest: {teams: {create}}}

    await expect(
      service.createTeam({
        slug: 'platform',
        name: 'Platform',
        privacy: 'closed',
        parentTeamId: 7,
      }),
    ).resolves.toMatchObject({
      parentTeam: {id: 7, slug: 'engineering'},
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({org: 'contoso', name: 'Platform', parent_team_id: 7}),
    )
  })

  describe('GitHubService.findUserByEmail', () => {
    it('uses the authenticated GraphQL search path for managed-user lookup', async () => {
      const service = new GitHubService('token', 'contoso')
      const graphql = vi.fn().mockResolvedValue({
        search: {
          nodes: [{__typename: 'User', login: 'ada'}],
        },
      })

      ;(service as unknown as {octokit: {graphql: typeof graphql}}).octokit = {
        graphql,
      }

      await expect(service.findUserByEmail('ada@contoso.com')).resolves.toEqual({
        login: 'ada',
        email: 'ada@contoso.com',
        type: 'User',
      })
      expect(graphql).toHaveBeenCalledTimes(1)
      expect(graphql).toHaveBeenCalledWith(expect.stringContaining('search(query: $query, type: USER'), {
        query: 'ada@contoso.com in:email org:contoso',
      })
    })
  })

  describe('GitHubService hierarchy preflight', () => {
    it('requests the repository representation and reads the current role', async () => {
      const service = new GitHubService('token', 'contoso')
      const checkPermissionsForRepoInOrg = vi.fn().mockResolvedValue({
        data: {
          role_name: 'maintain',
          permissions: {pull: true, triage: true, push: true, maintain: true, admin: false},
        },
      })
      ;(
        service as unknown as {
          octokit: {
            rest: {teams: {checkPermissionsForRepoInOrg: typeof checkPermissionsForRepoInOrg}}
          }
        }
      ).octokit = {rest: {teams: {checkPermissionsForRepoInOrg}}}

      await expect(
        service.getTeamRepositoryPermission('api-contributors', 'contoso/api'),
      ).resolves.toBe('maintain')
      expect(checkPermissionsForRepoInOrg).toHaveBeenCalledWith(
        expect.objectContaining({
          org: 'contoso',
          team_slug: 'api-contributors',
          owner: 'contoso',
          repo: 'api',
          headers: {accept: 'application/vnd.github.v3.repository+json'},
        }),
      )
    })

    it('rejects a custom repository role that cannot be represented', async () => {
      const service = new GitHubService('token', 'contoso')
      const checkPermissionsForRepoInOrg = vi.fn().mockResolvedValue({
        data: {role_name: 'security-reviewer', permissions: {pull: true}},
      })
      ;(
        service as unknown as {
          octokit: {
            rest: {teams: {checkPermissionsForRepoInOrg: typeof checkPermissionsForRepoInOrg}}
          }
        }
      ).octokit = {rest: {teams: {checkPermissionsForRepoInOrg}}}

      await expect(
        service.getTeamRepositoryPermission('api-contributors', 'contoso/api'),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('falls back from EMU external groups to team synchronization', async () => {
      const service = new GitHubService('token', 'contoso')
      const request = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('not an EMU organization'), {status: 404}))
        .mockResolvedValueOnce({data: {groups: []}})
      ;(service as unknown as {octokit: {request: typeof request}}).octokit = {request}

      await expect(service.isTeamIdpManaged('api-contributors')).resolves.toBe(false)
      expect(request).toHaveBeenNthCalledWith(
        1,
        'GET /orgs/{org}/teams/{team_slug}/external-groups',
        {org: 'contoso', team_slug: 'api-contributors'},
      )
      expect(request).toHaveBeenNthCalledWith(
        2,
        'GET /orgs/{org}/teams/{team_slug}/team-sync/group-mappings',
        {org: 'contoso', team_slug: 'api-contributors'},
      )
    })
  })
})
