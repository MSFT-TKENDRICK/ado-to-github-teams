import {Octokit} from '@octokit/rest'
import {withRetry} from '../healing/retry.js'
import type {GitHubTeam, GitHubUser} from '../types/index.js'
import type {RepositoryRole} from '../types/index.js'
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
  parent?: {id: number; slug: string} | null
}): GitHubTeam {
  if (input.privacy !== 'closed' && input.privacy !== 'secret') {
    throw new ValidationError(`GitHub did not return a valid privacy setting for team ${input.slug}`)
  }
  const team: GitHubTeam = {
    slug: input.slug,
    name: input.name,
    privacy: input.privacy,
  }
  if (typeof input.id === 'number') {
    team.id = input.id
  }
  if (input.description) {
    team.description = input.description
  }
  if (input.parent) {
    team.parentTeam = {id: input.parent.id, slug: input.parent.slug}
  }
  return team
}

function splitRepository(repository: string): {owner: string; repo: string} {
  const [owner, repo, extra] = repository.split('/')
  if (!owner || !repo || extra) {
    throw new ValidationError(`Invalid GitHub repository name: ${repository}`)
  }
  return {owner, repo}
}

function normalizeRepositoryRole(role: string): RepositoryRole | null {
  const normalized = role.toLowerCase()
  if (normalized === 'pull' || normalized === 'read') {
    return 'read'
  }
  if (normalized === 'push' || normalized === 'write') {
    return 'write'
  }
  if (normalized === 'triage' || normalized === 'maintain' || normalized === 'admin') {
    return normalized
  }
  return null
}

function repositoryRoleFromPermissions(permissions: unknown): RepositoryRole | null {
  if (!permissions || typeof permissions !== 'object') {
    return null
  }
  const values = permissions as Record<string, unknown>
  for (const role of ['admin', 'maintain', 'push', 'triage', 'pull'] as const) {
    if (values[role] === true) {
      return normalizeRepositoryRole(role)
    }
  }
  return null
}

function apiRepositoryRole(role: RepositoryRole): 'pull' | 'triage' | 'push' | 'maintain' | 'admin' {
  if (role === 'read') {
    return 'pull'
  }
  if (role === 'write') {
    return 'push'
  }
  return role
}

export class GitHubService {
  private octokit: Octokit

  public constructor(
    pat: string,
    private readonly org: string,
    private readonly apiBaseUrl = 'https://api.github.com',
  ) {
    this.octokit = this.createClient(pat)
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
        parent: response.data.parent
          ? {id: response.data.parent.id, slug: response.data.parent.slug}
          : null,
      })
    } catch (error) {
      const status = statusOf(error)
      if (status === 404) {
        return null
      }
      this.throwMappedError(error, `GET team ${slug}`)
    }
  }

  public async createTeam(
    team: Omit<GitHubTeam, 'id' | 'parentTeam'> & {parentTeamId?: number},
  ): Promise<GitHubTeam> {
    const existing = await this.getTeamBySlug(team.slug)
    if (existing) {
      if (existing.name !== team.name) {
        throw new HttpStatusError(
          `GitHub team slug ${team.slug} already exists for ${existing.name}; expected ${team.name}`,
          409,
        )
      }
      if (
        existing.privacy !== team.privacy ||
        (existing.parentTeam?.id ?? undefined) !== team.parentTeamId
      ) {
        throw new HttpStatusError(
          `GitHub team ${team.slug} exists with incompatible privacy or parent settings`,
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
        ...(team.parentTeamId === undefined ? {} : {parent_team_id: team.parentTeamId}),
      })
      return toGitHubTeam({
        id: response.data.id,
        slug: response.data.slug,
        name: response.data.name,
        description: response.data.description,
        ...(response.data.privacy ? {privacy: response.data.privacy} : {}),
        parent: response.data.parent
          ? {id: response.data.parent.id, slug: response.data.parent.slug}
          : null,
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

  public async getOrganizationBasePermission(): Promise<'none' | RepositoryRole> {
    try {
      const response = await withRetry(async () => this.octokit.rest.orgs.get({org: this.org}))
      const permission = response.data.default_repository_permission ?? 'none'
      const normalized = normalizeRepositoryRole(permission)
      if (permission === 'none') {
        return 'none'
      }
      if (!normalized) {
        throw new ValidationError(
          `Unsupported GitHub organization base repository permission: ${permission}`,
        )
      }
      return normalized
    } catch (error) {
      this.throwMappedError(error, `GET organization ${this.org}`)
    }
  }

  public async getRepository(repository: string): Promise<{
    fullName: string
    archived: boolean
    visibility: 'public' | 'private' | 'internal'
  }> {
    const {owner, repo} = splitRepository(repository)
    try {
      const response = await withRetry(async () => this.octokit.rest.repos.get({owner, repo}))
      const rawVisibility = response.data.visibility
      const visibility =
        rawVisibility === 'internal' || rawVisibility === 'private' || rawVisibility === 'public'
          ? rawVisibility
          : response.data.private
            ? 'private'
            : 'public'
      return {
        fullName: response.data.full_name,
        archived: response.data.archived,
        visibility,
      }
    } catch (error) {
      if (statusOf(error) === 404) {
        throw new NotFoundError(`GitHub repository not found: ${repository}`, 404)
      }
      this.throwMappedError(error, `GET repository ${repository}`)
    }
  }

  public async listTeamRepositories(teamSlug: string): Promise<string[]> {
    try {
      const repositories = await this.octokit.paginate(this.octokit.rest.teams.listReposInOrg, {
        org: this.org,
        team_slug: teamSlug,
        per_page: 100,
      })
      return repositories.map((repository) => repository.full_name)
    } catch (error) {
      this.throwMappedError(error, `GET repositories for team ${teamSlug}`)
    }
  }

  public async isTeamIdpManaged(teamSlug: string): Promise<boolean> {
    const routes = [
      'GET /orgs/{org}/teams/{team_slug}/external-groups',
      'GET /orgs/{org}/teams/{team_slug}/team-sync/group-mappings',
    ] as const
    const unavailable: OctokitErrorLike[] = []
    for (const route of routes) {
      try {
        const response = await withRetry(async () =>
          this.octokit.request(route, {
            org: this.org,
            team_slug: teamSlug,
          }),
        )
        const data = response.data as {groups?: unknown}
        if (!Array.isArray(data.groups)) {
          throw new ValidationError(
            `GitHub returned an invalid identity-provider group response for team ${teamSlug}`,
          )
        }
        return data.groups.length > 0
      } catch (error) {
        const status = statusOf(error)
        if (status === 403 || status === 404) {
          unavailable.push(error as OctokitErrorLike)
          continue
        }
        this.throwMappedError(error, `GET IdP groups for team ${teamSlug}`)
      }
    }
    const denied = unavailable.find((error) => statusOf(error) === 403)
    throw new PermissionError(
      `GitHub could not verify identity-provider management for team ${teamSlug}; the token must be authorized to inspect external groups or team synchronization`,
      denied ? 403 : undefined,
      denied?.response?.headers,
    )
  }

  public async getTeamRepositoryPermission(
    teamSlug: string,
    repository: string,
  ): Promise<RepositoryRole | null> {
    const {owner, repo} = splitRepository(repository)
    try {
      const response = await withRetry(async () =>
        this.octokit.rest.teams.checkPermissionsForRepoInOrg({
          org: this.org,
          team_slug: teamSlug,
          owner,
          repo,
          headers: {
            accept: 'application/vnd.github.v3.repository+json',
          },
        }),
      )
      const data = response.data as {permissions?: unknown; role_name?: unknown} | undefined
      const rawRole = typeof data?.role_name === 'string' ? data.role_name : undefined
      if (rawRole) {
        const role = normalizeRepositoryRole(rawRole)
        if (!role) {
          throw new ValidationError(
            `Unsupported custom repository role "${rawRole}" on ${teamSlug}/${repository}`,
          )
        }
        return role
      }
      const role = repositoryRoleFromPermissions(data?.permissions)
      if (!role) {
        throw new ValidationError(
          `GitHub did not return a repository role for ${teamSlug}/${repository}`,
        )
      }
      return role
    } catch (error) {
      if (statusOf(error) === 404) {
        return null
      }
      this.throwMappedError(error, `GET repository permission ${teamSlug}/${repository}`)
    }
  }

  public async setTeamRepositoryPermission(
    teamSlug: string,
    repository: string,
    role: RepositoryRole,
  ): Promise<void> {
    const {owner, repo} = splitRepository(repository)
    try {
      await withRetry(async () =>
        this.octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org: this.org,
          team_slug: teamSlug,
          owner,
          repo,
          permission: apiRepositoryRole(role),
        }),
      )
    } catch (error) {
      this.throwMappedError(error, `PUT repository permission ${teamSlug}/${repository}`)
    }
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
