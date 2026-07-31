import {execFile} from 'node:child_process'
import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {input} from '@inquirer/prompts'
import {
  DefaultAzureCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  useIdentityPlugin,
  type AccessToken,
  type GetTokenOptions,
  type TokenCredential,
} from '@azure/identity'

const execFileAsync = promisify(execFile)
const DEFAULT_PUBLIC_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'
const TOKEN_CACHE_NAME = 'ado-to-github-teams'

export const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default'
export const ENTRA_DELEGATED_SCOPES = [
  'https://graph.microsoft.com/User.Read.All',
  'https://graph.microsoft.com/GroupMember.Read.All',
] as const
export const ENTRA_APPLICATION_SCOPES = ['https://graph.microsoft.com/.default'] as const

export interface Config {
  entraClientId?: string
  entraClientTenantId?: string
  githubClientId?: string
}

export type AdoCredential =
  | {
      kind: 'pat'
      token: string
      source: 'environment'
    }
  | {
      kind: 'entra'
      credential: TokenCredential
      source: 'ambient'
    }

export interface ResolvedCredentials {
  ado: AdoCredential
  githubToken: string
  githubSource: 'environment' | 'github-cli' | 'device-code'
  entraCredential: TokenCredential
  entraScopes: readonly string[]
}

export class CredentialResolutionError extends Error {
  public constructor(
    public readonly provider: 'github' | 'entra',
    message: string,
    options: {readonly cause: unknown},
  ) {
    super(message, options)
    this.name = 'CredentialResolutionError'
  }
}

interface IdentityPluginState {
  broker: boolean
  cache: boolean
}

export interface AuthManagerOptions {
  configPath?: string
  env?: NodeJS.ProcessEnv
  interactive?: boolean
  platform?: NodeJS.Platform
  createAzureCredential?: (
    tenantId: string,
    clientId: string,
    interactive: boolean,
  ) => Promise<TokenCredential>
  resolveGitHubCredential?: (
    config: Config,
  ) => Promise<{token: string; source: ResolvedCredentials['githubSource']}>
  warn?: (message: string) => void
}

let identityPlugins: Promise<IdentityPluginState> | undefined

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  const value = values.find(hasValue)
  return value?.trim()
}

export function normalizeAmbientTenantId(tenantId: string): string | undefined {
  return ['common', 'consumers', 'organizations'].includes(tenantId.toLowerCase())
    ? undefined
    : tenantId
}

export function interactiveScopesFor(scopes: string | string[]): string | string[] {
  const requested = Array.isArray(scopes) ? scopes : [scopes]
  return requested.includes(ENTRA_APPLICATION_SCOPES[0]) ? [...ENTRA_DELEGATED_SCOPES] : scopes
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase()
  return Boolean(value && value !== 'false' && value !== '0')
}

function usesApplicationIdentity(env: NodeJS.ProcessEnv): boolean {
  const selected = env.AZURE_TOKEN_CREDENTIALS?.trim().toLowerCase()
  return Boolean(
    env.AZURE_CLIENT_SECRET ||
    env.ENTRA_CLIENT_SECRET ||
    env.AZURE_CLIENT_CERTIFICATE_PATH ||
    env.AZURE_FEDERATED_TOKEN_FILE ||
    selected === 'prod' ||
    selected === 'environmentcredential' ||
    selected === 'workloadidentitycredential' ||
    selected === 'managedidentitycredential' ||
    env.IDENTITY_ENDPOINT ||
    env.MSI_ENDPOINT,
  )
}

async function registerIdentityPlugins(
  platform: NodeJS.Platform,
  warn: (message: string) => void,
): Promise<IdentityPluginState> {
  if (identityPlugins) {
    return identityPlugins
  }

  identityPlugins = (async () => {
    let cache = false
    let broker = false
    try {
      const {cachePersistencePlugin} = await import('@azure/identity-cache-persistence')
      useIdentityPlugin(cachePersistencePlugin)
      cache = true
    } catch (error) {
      warn(`Encrypted Azure token cache is unavailable: ${String(error)}`)
    }

    if (platform === 'win32') {
      try {
        const {nativeBrokerPlugin} = await import('@azure/identity-broker')
        useIdentityPlugin(nativeBrokerPlugin)
        broker = true
      } catch (error) {
        warn(`Windows broker authentication is unavailable: ${String(error)}`)
      }
    }

    return {broker, cache}
  })()

  return identityPlugins
}

class InteractiveFallbackCredential implements TokenCredential {
  public constructor(
    private readonly ambient: TokenCredential,
    private readonly interactiveBrowser: TokenCredential | undefined,
    private readonly deviceCode: TokenCredential | undefined,
    private readonly explicitAzureConfiguration: boolean,
  ) {}

  public async getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    try {
      const token = await this.ambient.getToken(scopes, options)
      if (token) {
        return token
      }
    } catch (error) {
      if (this.explicitAzureConfiguration) {
        throw error
      }
      if (!this.interactiveBrowser && !this.deviceCode) {
        throw new Error(
          'No ambient Azure identity is available. Sign in with az login, Connect-AzAccount, or azd auth login; otherwise configure workload identity or service principal environment variables.',
          {cause: error},
        )
      }
    }

    if (this.interactiveBrowser) {
      try {
        const token = await this.interactiveBrowser.getToken(interactiveScopesFor(scopes), options)
        if (token) {
          return token
        }
      } catch (error) {
        if (!this.deviceCode) {
          throw error
        }
      }
    }

    if (this.deviceCode) {
      return this.deviceCode.getToken(interactiveScopesFor(scopes), options)
    }

    throw new Error(
      'No ambient Azure identity is available and interactive authentication is disabled.',
    )
  }
}

function readConfigString(value: unknown, key: keyof Config, target: Config): void {
  const text = typeof value === 'string' ? value : undefined
  if (hasValue(text)) {
    target[key] = text.trim()
  }
}

export class AuthManager {
  public static readonly DEFAULT_CONFIG_PATH = path.join(
    homedir(),
    '.ado-github-teams',
    'config.json',
  )

  private readonly configPath: string
  private readonly env: NodeJS.ProcessEnv
  private readonly interactive: boolean
  private readonly platform: NodeJS.Platform
  private readonly createAzureCredentialOverride?: AuthManagerOptions['createAzureCredential']
  private readonly resolveGitHubCredentialOverride?: AuthManagerOptions['resolveGitHubCredential']
  private readonly warn: (message: string) => void

  public constructor(options: AuthManagerOptions = {}) {
    this.configPath = options.configPath ?? AuthManager.DEFAULT_CONFIG_PATH
    this.env = options.env ?? process.env
    this.interactive =
      options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && !isCi(this.env))
    this.platform = options.platform ?? process.platform
    this.createAzureCredentialOverride = options.createAzureCredential
    this.resolveGitHubCredentialOverride = options.resolveGitHubCredential
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  public async loadConfig(): Promise<Config> {
    let content: string
    try {
      content = await readFile(this.configPath, 'utf8')
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code === 'ENOENT') {
        return {}
      }
      throw error
    }

    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Authentication config must be a JSON object: ${this.configPath}`)
    }

    const raw = parsed as Record<string, unknown>
    const config: Config = {}
    readConfigString(raw.entraClientId, 'entraClientId', config)
    readConfigString(raw.entraClientTenantId, 'entraClientTenantId', config)
    readConfigString(raw.githubClientId, 'githubClientId', config)

    if ('adoPat' in raw || 'githubPat' in raw || 'entraClientSecret' in raw) {
      await this.saveConfig(config)
      this.warn(`Removed legacy plaintext credentials from ${this.configPath}.`)
    }

    return config
  }

  public async saveConfig(config: Config): Promise<void> {
    const dir = path.dirname(this.configPath)
    await mkdir(dir, {recursive: true})
    await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(this.configPath, 0o600)
  }

  public async resolveCredentials(): Promise<ResolvedCredentials> {
    const entraCredential = await this.resolveAzureCredential()
    const config = await this.loadConfig()
    let github: {token: string; source: ResolvedCredentials['githubSource']}
    try {
      github = this.resolveGitHubCredentialOverride
        ? await this.resolveGitHubCredentialOverride(config)
        : await this.resolveGitHubCredential(config)
    } catch (error) {
      throw new CredentialResolutionError(
        'github',
        'No GitHub credential is available. Set GH_TOKEN or GITHUB_TOKEN, or run gh auth login before retrying.',
        {cause: error},
      )
    }
    const adoPat = this.env.ADO_PAT?.trim()

    return {
      ado: hasValue(adoPat)
        ? {kind: 'pat', token: adoPat, source: 'environment'}
        : {kind: 'entra', credential: entraCredential, source: 'ambient'},
      githubToken: github.token,
      githubSource: github.source,
      entraCredential,
      entraScopes: ENTRA_APPLICATION_SCOPES,
    }
  }

  public async resolveAzureCredential(): Promise<TokenCredential> {
    const config = await this.loadConfig()
    const tenantId =
      firstValue(this.env.AZURE_TENANT_ID, this.env.ENTRA_TENANT_ID, config.entraClientTenantId) ??
      'organizations'
    const clientId =
      firstValue(this.env.ENTRA_CLIENT_ID, this.env.ENTRA_PUBLIC_CLIENT_ID, config.entraClientId) ??
      DEFAULT_PUBLIC_CLIENT_ID
    let entraCredential: TokenCredential
    try {
      entraCredential = this.createAzureCredentialOverride
        ? await this.createAzureCredentialOverride(tenantId, clientId, this.interactive)
        : await this.createAzureCredential(tenantId, clientId)
    } catch (error) {
      throw new CredentialResolutionError(
        'entra',
        'Unable to resolve an Azure identity. Sign in with an Azure developer tool or configure a workload identity, then retry.',
        {cause: error},
      )
    }
    return entraCredential
  }

  private async createAzureCredential(
    tenantId: string,
    clientId: string,
  ): Promise<TokenCredential> {
    const legacyClientSecret = this.env.ENTRA_CLIENT_SECRET?.trim()
    if (hasValue(legacyClientSecret)) {
      if (
        clientId === DEFAULT_PUBLIC_CLIENT_ID ||
        normalizeAmbientTenantId(tenantId) === undefined
      ) {
        throw new Error(
          'ENTRA_CLIENT_SECRET requires both ENTRA_CLIENT_ID and a concrete ENTRA_TENANT_ID.',
        )
      }
      return new ClientSecretCredential(tenantId, clientId, legacyClientSecret)
    }

    const plugins = await registerIdentityPlugins(this.platform, this.warn)
    const ambientTenantId = normalizeAmbientTenantId(tenantId)
    const ambient = new DefaultAzureCredential({
      ...(ambientTenantId ? {tenantId: ambientTenantId} : {}),
      processTimeoutInMs: 10_000,
    })
    if (!this.interactive) {
      return new InteractiveFallbackCredential(
        ambient,
        undefined,
        undefined,
        usesApplicationIdentity(this.env),
      )
    }

    const persistenceOptions = plugins.cache
      ? {
          tokenCachePersistenceOptions: {
            enabled: true,
            name: TOKEN_CACHE_NAME,
            unsafeAllowUnencryptedStorage: false,
          },
        }
      : {}
    const interactiveBrowser = new InteractiveBrowserCredential({
      clientId,
      tenantId,
      ...persistenceOptions,
      ...(plugins.broker && this.platform === 'win32'
        ? {
            brokerOptions: {
              enabled: true as const,
              parentWindowHandle: new Uint8Array(0),
              useDefaultBrokerAccount: true,
            },
          }
        : {}),
    })
    const deviceCode = new DeviceCodeCredential({
      clientId,
      tenantId,
      ...persistenceOptions,
      userPromptCallback: (code) => console.log(code.message),
    })

    return new InteractiveFallbackCredential(
      ambient,
      interactiveBrowser,
      deviceCode,
      usesApplicationIdentity(this.env),
    )
  }

  private async resolveGitHubCredential(
    config: Config,
  ): Promise<{token: string; source: ResolvedCredentials['githubSource']}> {
    const environmentToken = firstValue(
      this.env.GH_TOKEN,
      this.env.GITHUB_TOKEN,
      this.env.GITHUB_PAT,
    )
    if (hasValue(environmentToken)) {
      return {token: environmentToken, source: 'environment'}
    }

    try {
      const {stdout} = await execFileAsync('gh', ['auth', 'token'], {
        encoding: 'utf8',
        env: this.env,
        windowsHide: true,
        timeout: 10_000,
      })
      if (hasValue(stdout)) {
        return {token: stdout.trim(), source: 'github-cli'}
      }
    } catch {
      // The GitHub CLI is an optional ambient source; interactive fallback is handled below.
    }

    if (!this.interactive) {
      throw new Error(
        'No GitHub credential is available. Set GH_TOKEN or GITHUB_TOKEN, or run gh auth login before retrying.',
      )
    }

    return {
      token: await this.runGitHubDeviceFlow(config.githubClientId),
      source: 'device-code',
    }
  }

  private async runGitHubDeviceFlow(configuredClientId?: string): Promise<string> {
    const clientId =
      firstValue(this.env.GITHUB_CLIENT_ID, configuredClientId) ??
      (await input({message: 'Enter GitHub OAuth app client ID for device flow:'})).trim()
    if (!hasValue(clientId)) {
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
        scope: 'read:org admin:org',
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
      throw new Error(
        `Unable to start GitHub device flow: ${startBody.error ?? startResponse.statusText}`,
      )
    }

    console.log(
      `Open ${startBody.verification_uri ?? 'https://github.com/login/device'} and enter code ${startBody.user_code}`,
    )
    let intervalMs = (startBody.interval ?? 5) * 1000
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
      if (tokenBody.error === 'slow_down') {
        intervalMs += 5000
      } else if (tokenBody.error && tokenBody.error !== 'authorization_pending') {
        throw new Error(`GitHub device flow failed: ${tokenBody.error}`)
      }
    }

    throw new Error('Timed out waiting for GitHub device flow authorization.')
  }
}
