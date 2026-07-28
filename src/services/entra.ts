import {ClientSecretCredential, DeviceCodeCredential} from '@azure/identity'
import {Client} from '@microsoft/microsoft-graph-client'
import {TokenCredentialAuthenticationProvider} from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js'
import {AuthManager} from '../auth/manager.js'
import {TokenRefresher} from '../healing/token-refresher.js'
import {withRetry} from '../healing/retry.js'
import type {EntraIdentity} from '../types/index.js'
import {NotFoundError, PermissionError} from '../utils/errors.js'

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

type TokenCredentialLike = ClientSecretCredential | DeviceCodeCredential

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class EntraService {
  private credential: TokenCredentialLike
  private graph: Client
  private readonly tokenRefresher: TokenRefresher

  public constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tenantId: string,
    tokenRefresher?: TokenRefresher,
  ) {
    this.tokenRefresher = tokenRefresher ?? new TokenRefresher()
    this.credential = this.createCredential(clientId, clientSecret, tenantId)
    this.graph = this.createGraphClient(this.credential)
  }

  public async getGroupMembers(
    groupId: string,
    transitive = false,
  ): Promise<EntraIdentity[]> {
    if (transitive) {
      return this.flattenGroup(groupId, 0, new Set<string>())
    }

    const endpoint = `/groups/${groupId}/members?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`
    const identities = await this.fetchPagedMembers(endpoint)
    if (identities.length > 500) {
      console.warn(`Group ${groupId} has ${identities.length} members; large group processing may be slow.`)
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
      .filter((obj): obj is GraphObject & {id: string; displayName: string; userPrincipalName: string} =>
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
      nextLink = page['@odata.nextLink']
    }

    return items
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

  private createCredential(
    clientId: string,
    clientSecret: string,
    tenantId: string,
  ): TokenCredentialLike {
    if (AuthManager.isDeviceFlowSecret(clientSecret) || clientSecret.trim().length === 0) {
      return new DeviceCodeCredential({
        clientId,
        tenantId,
        userPromptCallback: (info) => {
          console.log(info.message)
        },
      })
    }

    return new ClientSecretCredential(tenantId, clientId, clientSecret)
  }

  private createGraphClient(credential: TokenCredentialLike): Client {
    const scopes =
      credential instanceof DeviceCodeCredential
        ? ['https://graph.microsoft.com/User.Read']
        : ['https://graph.microsoft.com/.default']
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes,
    })
    return Client.initWithMiddleware({authProvider})
  }

  private async reloadCredentialFromConfig(): Promise<void> {
    const config = await new AuthManager().loadConfig()
    if (!config.entraClientId || !config.entraClientTenantId || config.entraClientSecret === undefined) {
      throw new Error('Entra credential refresh did not produce complete settings.')
    }
    this.credential = this.createCredential(
      config.entraClientId,
      config.entraClientSecret,
      config.entraClientTenantId,
    )
    this.graph = this.createGraphClient(this.credential)
  }

  private async request<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(async () => {
      try {
        return await fn()
      } catch (error) {
        const status = statusOf(error)
        if (status === 401) {
          const retried = await this.tokenRefresher.handleTokenExpiry('entra', async () => {
            await this.reloadCredentialFromConfig()
            return fn()
          })
          return retried as T
        }
        if (status === 403) {
          throw new PermissionError('Microsoft Graph permission denied.')
        }
        if (status === 404) {
          throw new NotFoundError('Microsoft Graph resource not found.')
        }
        throw asError(error)
      }
    })
  }
}
