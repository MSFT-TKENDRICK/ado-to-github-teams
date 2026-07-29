import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {input, password} from '@inquirer/prompts'
import {
  PublicClientApplication,
  type Configuration,
  type DeviceCodeRequest,
} from '@azure/msal-node'

const DEFAULT_PUBLIC_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'
const DEVICE_FLOW_SENTINEL_SECRET = '__DEVICE_FLOW__'
export const ENTRA_DELEGATED_SCOPES = [
  'https://graph.microsoft.com/User.Read.All',
  'https://graph.microsoft.com/GroupMember.Read.All',
] as const
export type AdoTokenType = 'pat' | 'bearer'

export interface Config {
  adoPat?: string
  adoTokenType?: AdoTokenType
  githubPat?: string
  entraClientId?: string
  entraClientSecret?: string
  entraClientTenantId?: string
}

export interface ResolvedCredentials {
  adoPat: string
  adoTokenType: AdoTokenType
  githubPat: string
  entraClientId: string
  entraClientSecret: string
  entraClientTenantId: string
}

export interface DeviceFlowClient {
  acquireTokenByDeviceCode(
    request: DeviceCodeRequest,
  ): Promise<{accessToken?: string} | null>
}

export type DeviceFlowClientFactory = (configuration: Configuration) => DeviceFlowClient

function parseAdoTokenType(value: string | undefined): AdoTokenType {
  if (value === undefined || value === 'pat') {
    return 'pat'
  }
  if (value === 'bearer') {
    return 'bearer'
  }
  throw new Error('ADO_TOKEN_TYPE must be either "pat" or "bearer".')
}

function requireStoredAdoTokenType(config: Config): AdoTokenType {
  if (config.adoTokenType === 'pat' || config.adoTokenType === 'bearer') {
    return config.adoTokenType
  }
  if (config.adoTokenType === undefined) {
    throw new Error(
      'The stored Azure DevOps credential predates explicit token typing. ' +
        'Remove adoPat from config.json and run auth again.',
    )
  }
  throw new Error('The stored Azure DevOps credential has an unsupported token type.')
}

export class AuthManager {
  public static readonly DEFAULT_CONFIG_PATH = path.join(
    homedir(),
    '.ado-github-teams',
    'config.json',
  )

  private readonly configPath: string

  public constructor(
    configPath = AuthManager.DEFAULT_CONFIG_PATH,
    private readonly createDeviceFlowClient: DeviceFlowClientFactory = (configuration) =>
      new PublicClientApplication(configuration),
  ) {
    this.configPath = configPath
  }

  public async loadConfig(): Promise<Config> {
    try {
      const content = await readFile(this.configPath, 'utf8')
      return JSON.parse(content) as Config
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code === 'ENOENT') {
        return {}
      }

      throw error
    }
  }

  public async saveConfig(config: Config): Promise<void> {
    const dir = path.dirname(this.configPath)
    await mkdir(dir, {recursive: true})
    await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }

  public async resolveCredentials(): Promise<ResolvedCredentials> {
    const config = await this.loadConfig()

    let adoPat: string
    let adoTokenType: AdoTokenType
    if (process.env.ADO_PAT) {
      adoPat = process.env.ADO_PAT
      adoTokenType = parseAdoTokenType(process.env.ADO_TOKEN_TYPE)
    } else if (config.adoPat) {
      adoPat = config.adoPat
      adoTokenType = requireStoredAdoTokenType(config)
    } else {
      adoPat = await this.runAdoDeviceFlow(process.env.ADO_TENANT_ID)
      adoTokenType = 'bearer'
    }

    const githubPat =
      process.env.GITHUB_PAT ?? config.githubPat ?? (await this.runGitHubDeviceFlow())

    const entraClientId =
      process.env.ENTRA_CLIENT_ID ??
      config.entraClientId ??
      process.env.ENTRA_PUBLIC_CLIENT_ID ??
      DEFAULT_PUBLIC_CLIENT_ID
    const entraClientTenantId =
      process.env.ENTRA_TENANT_ID ?? config.entraClientTenantId ?? 'organizations'
    const entraClientSecret =
      process.env.ENTRA_CLIENT_SECRET ??
      config.entraClientSecret ??
      (await this.resolveEntraSecretWithFallback(entraClientId, entraClientTenantId))

    const resolved: ResolvedCredentials = {
      adoPat,
      adoTokenType,
      githubPat,
      entraClientId,
      entraClientSecret,
      entraClientTenantId,
    }

    await this.saveConfig({
      adoPat: resolved.adoPat,
      adoTokenType: resolved.adoTokenType,
      githubPat: resolved.githubPat,
      entraClientId: resolved.entraClientId,
      entraClientSecret: resolved.entraClientSecret,
      entraClientTenantId: resolved.entraClientTenantId,
    })

    return resolved
  }

  public async refreshCredential(service: 'ado' | 'github' | 'entra'): Promise<void> {
    const config = await this.loadConfig()
    if (service === 'ado') {
      config.adoPat = await this.runAdoDeviceFlow(process.env.ADO_TENANT_ID)
      config.adoTokenType = 'bearer'
    } else if (service === 'github') {
      config.githubPat = await this.runGitHubDeviceFlow()
    } else {
      const entraClientId =
        process.env.ENTRA_CLIENT_ID ??
        config.entraClientId ??
        process.env.ENTRA_PUBLIC_CLIENT_ID ??
        DEFAULT_PUBLIC_CLIENT_ID
      const tenantId = process.env.ENTRA_TENANT_ID ?? config.entraClientTenantId ?? 'organizations'
      config.entraClientId = entraClientId
      config.entraClientTenantId = tenantId
      config.entraClientSecret = await this.resolveEntraSecretWithFallback(
        entraClientId,
        tenantId,
      )
    }

    await this.saveConfig(config)
  }

  private async resolveEntraSecretWithFallback(
    clientId: string,
    tenantId: string,
  ): Promise<string> {
    const provided = await password({
      message:
        'Enter Entra client secret (leave empty to use interactive device flow fallback):',
      mask: '*',
    })
    if (provided.trim().length > 0) {
      return provided.trim()
    }

    await this.runEntraDeviceFlow(clientId, tenantId)
    return DEVICE_FLOW_SENTINEL_SECRET
  }

  public static isDeviceFlowSecret(secret: string): boolean {
    return secret === DEVICE_FLOW_SENTINEL_SECRET
  }

  private async runAdoDeviceFlow(tenantId = 'organizations'): Promise<string> {
    const clientId = process.env.ENTRA_PUBLIC_CLIENT_ID ?? DEFAULT_PUBLIC_CLIENT_ID
    const app = this.createDeviceFlowClient({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    })
    const response = await app.acquireTokenByDeviceCode({
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/user_impersonation'],
      deviceCodeCallback: (code) => {
        console.log(code.message)
      },
    })
    if (!response?.accessToken) {
      throw new Error('Failed to acquire Azure DevOps token via device flow.')
    }

    return response.accessToken
  }

  private async runEntraDeviceFlow(clientId: string, tenantId: string): Promise<void> {
    const app = this.createDeviceFlowClient({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    })
    const response = await app.acquireTokenByDeviceCode({
      scopes: [...ENTRA_DELEGATED_SCOPES],
      deviceCodeCallback: (code) => {
        console.log(code.message)
      },
    })
    if (!response?.accessToken) {
      throw new Error('Failed to acquire Microsoft Graph token via device flow.')
    }
  }

  private async runGitHubDeviceFlow(): Promise<string> {
    const clientId =
      process.env.GITHUB_CLIENT_ID ??
      (await input({message: 'Enter GitHub OAuth app client ID for device flow:'}))
    if (!clientId) {
      throw new Error('GitHub client ID is required for device flow.')
    }

    const startResponse = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        scope: 'read:org write:org admin:org',
      }),
    })
    const startBody = (await startResponse.json()) as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      interval?: number
      expires_in?: number
      error?: string
    }
    if (!startResponse.ok || !startBody.device_code || !startBody.user_code) {
      throw new Error(`Unable to start GitHub device flow: ${startBody.error ?? startResponse.statusText}`)
    }

    console.log(
      `Open ${startBody.verification_uri ?? 'https://github.com/login/device'} and enter code ${startBody.user_code}`,
    )
    const intervalMs = (startBody.interval ?? 5) * 1000
    const expiresAt = Date.now() + (startBody.expires_in ?? 900) * 1000
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: startBody.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })
      const tokenBody = (await tokenResponse.json()) as {
        access_token?: string
        error?: string
      }
      if (tokenBody.access_token) {
        return tokenBody.access_token
      }
      if (tokenBody.error && tokenBody.error !== 'authorization_pending') {
        throw new Error(`GitHub device flow failed: ${tokenBody.error}`)
      }
    }

    throw new Error('Timed out waiting for GitHub device flow authorization.')
  }
}
