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

const RemoteWorldConfigSchema = Schema.Struct({
  mode: Schema.Literal('remote'),
  target: Schema.String,
})

const WorldRuntimeConfigSchema = Schema.Union(LocalWorldConfigSchema, RemoteWorldConfigSchema)

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

export function resolveWorldRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorldRuntimeConfig {
  const target = environment.WORKFLOW_TARGET_WORLD?.trim()
  const raw: unknown =
    target && target !== 'local' && target !== './dist/workflow/world.js'
      ? {
          mode: 'remote',
          target,
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
    throw new Error(`Invalid workflow World configuration: ${String(decoded.left)}`)
  }

  if (decoded.right.mode === 'remote' && environment.WORKFLOW_ALLOW_REMOTE_TARGET !== 'true') {
    throw new Error('Remote Workflow World targets require WORKFLOW_ALLOW_REMOTE_TARGET=true.')
  }

  return decoded.right
}
