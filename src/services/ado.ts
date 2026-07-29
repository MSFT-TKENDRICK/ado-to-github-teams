import * as azdev from 'azure-devops-node-api'
import {AuthManager, type AdoTokenType} from '../auth/manager.js'
import {TokenRefresher} from '../healing/token-refresher.js'
import {withRetry} from '../healing/retry.js'
import type {AdoMember, AdoTeam} from '../types/index.js'
import {NotFoundError, PermissionError} from '../utils/errors.js'

interface AdoListResponse<T> {
  count?: number
  value?: T[]
}

interface RawAdoTeam {
  id?: string
  name?: string
  description?: string
  projectId?: string
  projectName?: string
}

interface RawAdoMember {
  id?: string
  displayName?: string
  uniqueName?: string
  email?: string
  isContainer?: boolean
  descriptor?: string
  identity?: {
    id?: string
    displayName?: string
    uniqueName?: string
    mailAddress?: string
    descriptor?: string
    isContainer?: boolean
  }
}

interface StatusErrorLike extends Error {
  statusCode?: number
  status?: number
  response?: {
    status?: number
  }
}

function statusOf(error: unknown): number | undefined {
  const typed = error as StatusErrorLike
  return typed.status ?? typed.statusCode ?? typed.response?.status
}

export class AdoService {
  private readonly tokenRefresher: TokenRefresher
  private webApi: azdev.WebApi
  private currentToken: string

  public constructor(
    pat: string,
    private readonly orgUrl: string,
    private currentTokenType: AdoTokenType = 'pat',
    tokenRefresher?: TokenRefresher,
  ) {
    this.currentToken = pat
    this.webApi = this.createWebApi(pat)
    this.tokenRefresher = tokenRefresher ?? new TokenRefresher()
  }

  public async getTeams(projectName: string): Promise<AdoTeam[]> {
    const teams = await this.paginate<RawAdoTeam>(async (skip, top) => {
      const url = `${this.orgUrl.replace(/\/+$/, '')}/_apis/projects/${encodeURIComponent(projectName)}/teams?api-version=7.1-preview.3&$skip=${skip}&$top=${top}`
      const response = await this.request<AdoListResponse<RawAdoTeam>>(url)
      return response.value ?? []
    })

    return teams
      .filter((team): team is RawAdoTeam & {id: string; name: string; projectId: string} =>
        Boolean(team.id && team.name && team.projectId),
      )
      .map((team) => {
        const normalized: AdoTeam = {
          id: team.id,
          name: team.name,
          projectId: team.projectId,
          projectName: team.projectName ?? projectName,
        }
        if (team.description) {
          normalized.description = team.description
        }
        return normalized
      })
  }

  public async getTeamMembers(projectId: string, teamId: string): Promise<AdoMember[]> {
    const members = await this.paginate<RawAdoMember>(async (skip, top) => {
      const url = `${this.orgUrl.replace(/\/+$/, '')}/_apis/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/members?api-version=7.1-preview.3&$skip=${skip}&$top=${top}`
      const response = await this.request<AdoListResponse<RawAdoMember>>(url)
      return response.value ?? []
    })

    return members
      .map((raw): AdoMember | null => {
        const identity = raw.identity
        const id = identity?.id ?? raw.id
        const displayName = identity?.displayName ?? raw.displayName
        const uniqueName = identity?.uniqueName ?? raw.uniqueName
        if (!id || !displayName || !uniqueName) {
          return null
        }
        const normalized: AdoMember = {
          id,
          displayName,
          uniqueName,
          isContainer: raw.isContainer ?? identity?.isContainer ?? false,
        }
        const email = raw.email ?? identity?.mailAddress
        if (email) {
          normalized.email = email
        }
        const descriptor = raw.descriptor ?? identity?.descriptor
        if (descriptor) {
          normalized.descriptor = descriptor
        }
        return normalized
      })
      .filter((member): member is AdoMember => member !== null)
  }

  public async resolveGroupOriginId(descriptor: string): Promise<string | null> {
    const normalizedOrg = this.orgUrl.replace(/\/+$/, '')
    const url = `${normalizedOrg}/_apis/graph/groups/${encodeURIComponent(descriptor)}?api-version=7.1-preview.1`
    try {
      const response = await this.request<{
        originId?: string
      }>(url)
      return response.originId ?? null
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null
      }
      throw error
    }
  }

  private async paginate<T>(fn: (skip: number, top: number) => Promise<T[]>): Promise<T[]> {
    const top = 100
    let skip = 0
    const items: T[] = []
    let hasMore = true

    while (hasMore) {
      const page = await fn(skip, top)
      items.push(...page)
      hasMore = page.length >= top
      if (hasMore) {
        skip += top
      }
    }

    return items
  }

  private createWebApi(token: string): azdev.WebApi {
    const handler = this.currentTokenType === 'bearer'
      ? azdev.getBearerHandler(token)
      : azdev.getPersonalAccessTokenHandler(token)
    return new azdev.WebApi(this.orgUrl, handler)
  }

  private async reloadTokenFromConfig(): Promise<void> {
    const manager = new AuthManager()
    const config = await manager.loadConfig()
    if (!config.adoPat) {
      throw new Error('ADO credential refresh did not produce a token.')
    }
    if (config.adoTokenType !== 'pat' && config.adoTokenType !== 'bearer') {
      throw new Error(
        'ADO credential refresh did not record a supported token type. Run auth again.',
      )
    }
    this.currentToken = config.adoPat
    this.currentTokenType = config.adoTokenType
    this.webApi = this.createWebApi(this.currentToken)
  }

  private async request<T>(url: string): Promise<T> {
    return withRetry(async () => {
      try {
        const response = await this.webApi.rest.get<unknown>(url)
        return response.result as T
      } catch (error) {
        const status = statusOf(error)
        if (status === 401) {
          const retried = await this.tokenRefresher.handleTokenExpiry('ado', async () => {
            await this.reloadTokenFromConfig()
            const retryResponse = await this.webApi.rest.get<unknown>(url)
            return retryResponse.result
          })
          return retried as T
        }
        if (status === 403) {
          throw new PermissionError(`ADO permission denied for ${url}`, 403)
        }
        if (status === 404) {
          throw new NotFoundError(`ADO resource not found: ${url}`, 404)
        }
        throw error
      }
    })
  }
}
