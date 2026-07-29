import {describe, expect, it, vi} from 'vitest'
import {GitHubService} from '../../../src/services/github.js'
import {HttpStatusError} from '../../../src/utils/errors.js'

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
})
