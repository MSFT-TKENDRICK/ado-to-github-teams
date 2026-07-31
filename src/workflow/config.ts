import path from 'node:path'
import {homedir} from 'node:os'
import {Either, Schema} from 'effect'

const LocalWorldConfigSchema = Schema.Struct({
  mode: Schema.Literal('local'),
  sqlitePath: Schema.String,
  natsUrls: Schema.NonEmptyArray(Schema.String),
  baseUrl: Schema.String,
  queueConcurrency: Schema.Number,
})

const AzureWorldConfigSchema = Schema.Struct({
  mode: Schema.Literal('azure'),
  databaseUrl: Schema.NonEmptyString,
  databaseAuthToken: Schema.NonEmptyString,
  starterUrl: Schema.NonEmptyString,
  deploymentId: Schema.NonEmptyString,
  baseUrl: Schema.NonEmptyString,
})

const WorldRuntimeConfigSchema = Schema.Union(LocalWorldConfigSchema, AzureWorldConfigSchema)

export type WorldRuntimeConfig = typeof WorldRuntimeConfigSchema.Type

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`)
  }
  return parsed
}

function requireRemoteUrl(value: string, name: string, protocols: readonly string[]): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid workflow World configuration: ${name} must be a valid URL.`)
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(
      `Invalid workflow World configuration: ${name} must use ${protocols.join(' or ')}.`,
    )
  }
}

export function resolveWorldRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorldRuntimeConfig {
  const target = environment.WORKFLOW_TARGET_WORLD?.trim()
  const raw: unknown =
    target === 'azure'
      ? {
          mode: 'azure',
          databaseUrl: environment.AZURE_WORLD_DATABASE_URL,
          databaseAuthToken: environment.AZURE_WORLD_DATABASE_AUTH_TOKEN,
          starterUrl: environment.AZURE_DURABLE_STARTER_URL,
          deploymentId: environment.A2G_DEPLOYMENT_ID,
          baseUrl: environment.WORKFLOW_BASE_URL,
        }
      : {
          mode: 'local',
          sqlitePath:
            environment.WORKFLOW_SQLITE_PATH ??
            path.join(homedir(), '.ado-github-teams', 'workflow.db'),
          natsUrls: (environment.WORKFLOW_NATS_URLS ?? 'nats://127.0.0.1:4222')
            .split(',')
            .map((url) => url.trim())
            .filter((url) => url.length > 0),
          baseUrl: environment.WORKFLOW_BASE_URL ?? 'http://127.0.0.1:7331',
          queueConcurrency: positiveInteger(environment.WORKFLOW_NATS_CONCURRENCY, 10),
        }

  const decoded = Schema.decodeUnknownEither(WorldRuntimeConfigSchema)(raw)
  if (Either.isLeft(decoded)) {
    throw new Error('Invalid workflow World configuration.')
  }

  if (target && target !== 'local' && target !== 'azure') {
    throw new Error('WORKFLOW_TARGET_WORLD must be local or azure.')
  }

  if (decoded.right.mode === 'azure') {
    requireRemoteUrl(decoded.right.databaseUrl, 'AZURE_WORLD_DATABASE_URL', [
      'http:',
      'https:',
      'libsql:',
      'wss:',
    ])
    requireRemoteUrl(decoded.right.starterUrl, 'AZURE_DURABLE_STARTER_URL', ['http:', 'https:'])
    requireRemoteUrl(decoded.right.baseUrl, 'WORKFLOW_BASE_URL', ['http:', 'https:'])
  }

  return decoded.right
}
