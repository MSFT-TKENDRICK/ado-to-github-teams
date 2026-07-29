import {Octokit} from '@octokit/rest'
import {AuthManager} from '../auth/manager.js'
import {withRetry} from '../healing/retry.js'
import type {GitHubTeam, GitHubUser} from '../types/index.js'
import {
  AmbiguousMatchError,
  HttpStatusError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from '../utils/errors.js'

interface OctokitErrorLike extends Error {
  status?: number
  response?: {
    status?: number
    headers?: Record<string, string | undefined>
  }
}

function statusOf(error: unknown): number | undefined {
  const typed = error as OctokitErrorLike
  return typed.status ?? typed.response?.status
}

function ssoHeaderOf(error: unknown): string | undefined {
  const typed = error as OctokitErrorLike
  return typed.response?.headers?.['x-github-sso']
}

function toGitHubTeam(input: {
  id?: number
  slug: string
  name: string
  description?: string | null
  privacy?: string | null
}): GitHubTeam {
  const team: GitHubTeam = {
    slug: input.slug,
    name: input.name,
    privacy: (input.privacy ?? 'closed') as 'closed' | 'secret',
  }
  if (typeof input.id === 'number') {
    team.id = input.id
  }
  if (input.description) {
    team.description = input.description
  }
  return team
}

export class GitHubService {
  private octokit: Octokit
  private currentToken: string

  public constructor(
    private readonly pat: string,
    private readonly org: string,
    private readonly apiBaseUrl = 'https://api.github.com',
  ) {
    this.currentToken = pat
    this.octokit = this.createClient(this.currentToken)
  }

  public async getTeamBySlug(slug: string): Promise<GitHubTeam | null> {
    try {
      const response = await withRetry(async () =>
        this.octokit.rest.teams.getByName({org: this.org, team_slug: slug}),
      )
      return toGitHubTeam({
        id: response.data.id,
        slug: response.data.slug,
        name: response.data.name,
        description: response.data.description,
        ...(response.data.privacy ? {privacy: response.data.privacy} : {}),
      })
    } catch (error) {
      const status = statusOf(error)
      if (status === 404) {
        return null
      }
      this.throwMappedError(error, `GET team ${slug}`)
    }
  }

  public async createTeam(team: Omit<GitHubTeam, 'id'>): Promise<GitHubTeam> {
    const existing = await this.getTeamBySlug(team.slug)
    if (existing) {
      if (existing.name !== team.name) {
        throw new HttpStatusError(
          `GitHub team slug ${team.slug} already exists for ${existing.name}; expected ${team.name}`,
          409,
        )
      }
      return existing
    }

    try {
      const response = await this.octokit.rest.teams.create({
        org: this.org,
        name: team.name,
        description: team.description ?? '',
        privacy: team.privacy,
      })
      return toGitHubTeam({
        id: response.data.id,
        slug: response.data.slug,
        name: response.data.name,
        description: response.data.description,
        ...(response.data.privacy ? {privacy: response.data.privacy} : {}),
      })
    } catch (error) {
      if (statusOf(error) === 422) {
        throw new ValidationError(`GitHub team validation failed for ${team.name}`, 422)
      }
      this.throwMappedError(error, `POST team ${team.name}`)
    }
  }

  public async addTeamMember(teamSlug: string, username: string): Promise<void> {
    try {
      const membership = await withRetry(async () =>
        this.octokit.rest.teams.getMembershipForUserInOrg({
          org: this.org,
          team_slug: teamSlug,
          username,
        }),
      )
      if (membership.status === 200 && membership.data.state === 'active') {
        return
      }
    } catch (error) {
      if (statusOf(error) !== 404) {
        this.throwMappedError(error, `GET team membership ${teamSlug}/${username}`)
      }
    }

    try {
      await withRetry(async () =>
        this.octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
          org: this.org,
          team_slug: teamSlug,
          username,
          role: 'member',
        }),
      )
    } catch (error) {
      if (statusOf(error) === 422) {
        throw new ValidationError(
          `Unable to add ${username} to ${teamSlug}. The user may be suspended or invalid.`,
          422,
        )
      }
      if (statusOf(error) === 404) {
        throw new NotFoundError(`GitHub user or team not found: ${teamSlug}/${username}`, 404)
      }
      this.throwMappedError(error, `PUT team membership ${teamSlug}/${username}`)
    }
  }

  public async findUserByEmail(email: string): Promise<GitHubUser | null> {
    const response = await withRetry(async () =>
      this.octokit.graphql<{
        search: {
          nodes: Array<{
            __typename: string
            login?: string
          }>
        }
      }>(
        `
          query FindUsersByEmail($query: String!) {
            search(query: $query, type: USER, first: 10) {
              nodes {
                __typename
                ... on User {
                  login
                }
              }
            }
          }
        `,
        {
          query: `${email} in:email org:${this.org}`,
        },
      ),
    )
    const matches = response.search.nodes.filter(
      (item): item is {__typename: 'User'; login: string} =>
        item.__typename === 'User' && typeof item.login === 'string' && item.login.length > 0,
    )
    if (matches.length === 0) {
      return null
    }
    if (matches.length > 1) {
      throw new AmbiguousMatchError(
        `Multiple GitHub users match email ${email}`,
        matches.map((user) => user.login),
      )
    }

    const user = matches[0]
    if (!user) {
      return null
    }
    return {
      login: user.login,
      email,
      type: 'User',
    }
  }

  public async isUserSuspended(login: string): Promise<boolean> {
    const response = await withRetry(async () =>
      this.octokit.rest.users.getByUsername({username: login}),
    )
    const data = response.data as Record<string, unknown>
    if (typeof data.suspended_at === 'string' && data.suspended_at.length > 0) {
      return true
    }

    return false
  }

  public async reloadTokenFromConfig(): Promise<void> {
    const config = await new AuthManager().loadConfig()
    if (!config.githubPat) {
      throw new Error('GitHub credential refresh did not produce a token.')
    }
    this.currentToken = config.githubPat
    this.octokit = this.createClient(this.currentToken)
  }

  private createClient(token: string): Octokit {
    return new Octokit({
      auth: token,
      baseUrl: this.apiBaseUrl,
      userAgent: 'ado-to-github-teams',
    })
  }

  private throwMappedError(error: unknown, operation: string): never {
    const status = statusOf(error)
    if (status === 401) {
      throw new HttpStatusError(`GitHub authentication failed during ${operation}`, 401)
    }
    if (status === 403) {
      const sso = ssoHeaderOf(error)
      if (sso) {
        throw new HttpStatusError(
          `GitHub SSO enforcement blocked ${operation}`,
          403,
          {'x-github-sso': sso},
        )
      }
      throw new PermissionError(`GitHub access denied during ${operation}`, 403)
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}
