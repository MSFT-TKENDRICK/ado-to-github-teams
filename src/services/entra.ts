import type {TokenCredential} from '@azure/identity'
import {Client} from '@microsoft/microsoft-graph-client'
import {TokenCredentialAuthenticationProvider} from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js'
import {withRetry} from '../healing/retry.js'
import type {EntraIdentity} from '../types/index.js'
import {HttpStatusError, NotFoundError, PermissionError} from '../utils/errors.js'

interface GraphObject {
  id?: string
  displayName?: string
  userPrincipalName?: string
  mail?: string
  accountEnabled?: boolean
  userType?: string
  ['@odata.type']?: string
}

interface GraphPage {
  value?: GraphObject[]
  ['@odata.nextLink']?: string
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class EntraService {
  private readonly graph: Client

  public constructor(
    private readonly credential: TokenCredential,
    private readonly scopes: readonly string[],
    graphClient?: Client,
    private readonly graphBaseUrl = 'https://graph.microsoft.com/v1.0',
  ) {
    this.graph = graphClient ?? this.createGraphClient(this.credential)
  }

  public async getGroupMembers(groupId: string, transitive = false): Promise<EntraIdentity[]> {
    if (transitive) {
      return this.flattenGroup(groupId, 0, new Set<string>())
    }

    const endpoint = `/groups/${groupId}/members?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`
    const identities = await this.fetchPagedMembers(endpoint)
    if (identities.length > 500) {
      console.warn(
        `Group ${groupId} has ${identities.length} members; large group processing may be slow.`,
      )
    }
    return identities
  }

  public async resolveUserByUpn(upn: string): Promise<EntraIdentity | null> {
    try {
      const user = await this.request<GraphObject>(() =>
        this.graph
          .api(`/users/${encodeURIComponent(upn)}`)
          .select(['id', 'displayName', 'userPrincipalName', 'mail', 'accountEnabled', 'userType'])
          .get(),
      )
      if (!user.id || !user.displayName || !user.userPrincipalName) {
        return null
      }
      return this.toIdentity(user)
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null
      }
      throw error
    }
  }

  private detectCycle(groupId: string, visited: Set<string>): boolean {
    return visited.has(groupId)
  }

  private async flattenGroup(
    groupId: string,
    depth: number,
    visited: Set<string>,
  ): Promise<EntraIdentity[]> {
    if (depth > 5) {
      const depthError = new Error(`Nested group depth limit exceeded at group ${groupId}`)
      depthError.name = 'NESTED_GROUP_DEPTH_EXCEEDED'
      throw depthError
    }
    if (this.detectCycle(groupId, visited)) {
      const circular = new Error(`Circular group reference detected for group ${groupId}`)
      circular.name = 'CIRCULAR_GROUP'
      throw circular
    }

    visited.add(groupId)
    const endpoint = `/groups/${groupId}/members?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType,@odata.type`
    const rawItems = await this.fetchPagedRaw(endpoint)
    const users: EntraIdentity[] = []

    for (const item of rawItems) {
      if (!item.id) {
        continue
      }
      if (item['@odata.type']?.toLowerCase().includes('group')) {
        const nested = await this.flattenGroup(item.id, depth + 1, visited)
        users.push(...nested)
      } else if (item.userPrincipalName) {
        users.push(this.toIdentity(item))
      }
    }

    visited.delete(groupId)
    const byId = new Map<string, EntraIdentity>()
    for (const user of users) {
      byId.set(user.id, user)
    }
    if (byId.size > 500) {
      console.warn(`Group ${groupId} has ${byId.size} transitive members; continuing pagination.`)
    }
    return [...byId.values()]
  }

  private async fetchPagedMembers(endpoint: string): Promise<EntraIdentity[]> {
    const objects = await this.fetchPagedRaw(endpoint)
    return objects
      .filter(
        (obj): obj is GraphObject & {id: string; displayName: string; userPrincipalName: string} =>
          Boolean(obj.id && obj.displayName && obj.userPrincipalName),
      )
      .map((obj) => this.toIdentity(obj))
  }

  private async fetchPagedRaw(endpoint: string): Promise<GraphObject[]> {
    const items: GraphObject[] = []
    let nextLink: string | undefined = endpoint

    while (nextLink) {
      const pageUrl: string = nextLink
      const page = await this.request<GraphPage>(
        async (): Promise<GraphPage> => this.graph.api(pageUrl).get() as Promise<GraphPage>,
      )
      items.push(...(page.value ?? []))
      nextLink = this.normalizeNextLink(page['@odata.nextLink'])
    }

    return items
  }

  private normalizeNextLink(nextLink: string | undefined): string | undefined {
    const productionBaseUrl = 'https://graph.microsoft.com/v1.0'
    if (!nextLink || this.graphBaseUrl === productionBaseUrl) {
      return nextLink
    }
    return nextLink.startsWith(productionBaseUrl)
      ? nextLink.slice(productionBaseUrl.length)
      : nextLink
  }

  private toIdentity(user: GraphObject): EntraIdentity {
    const identity: EntraIdentity = {
      id: user.id ?? '',
      displayName: user.displayName ?? user.userPrincipalName ?? 'Unknown',
      userPrincipalName: user.userPrincipalName ?? '',
      isGuest: (user.userType ?? '').toLowerCase() === 'guest',
    }
    if (user.mail) {
      identity.mail = user.mail
    }
    if (typeof user.accountEnabled === 'boolean') {
      identity.accountEnabled = user.accountEnabled
    }
    return identity
  }

  private createGraphClient(credential: TokenCredential): Client {
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: [...this.scopes],
    })
    return Client.initWithMiddleware({authProvider})
  }

  private async request<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(async () => {
      try {
        return await fn()
      } catch (error) {
        const status = statusOf(error)
        if (status === 401) {
          throw new HttpStatusError('Microsoft Graph authentication failed.', 401)
        }
        if (status === 403) {
          throw new PermissionError('Microsoft Graph permission denied.', 403)
        }
        if (status === 404) {
          throw new NotFoundError('Microsoft Graph resource not found.', 404)
        }
        throw asError(error)
      }
    })
  }
}
