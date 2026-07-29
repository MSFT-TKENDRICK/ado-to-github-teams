import {createRequire} from 'node:module'
import {createWorld as createSqliteWorld} from '@workflow-worlds/turso'
import {createWorld as createNatsWorld} from '@fantasticfour/world-nats-jetstream'
import type {
  Event,
  GetEventParams,
  StreamChunksResponse,
  StreamInfoResponse,
  World,
} from '@workflow/world'
import {reenqueueActiveRuns, SPEC_VERSION_CURRENT} from '@workflow/world'
import type {WorldRuntimeConfig} from './config.js'
import {
  startStrandedRunReconciler,
  type StrandedRunReconcilerHandle,
} from './recovery.js'

const RECONCILER_LABEL = 'world-durable-local'

function positiveIntEnv(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]
  if (!raw) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

interface StreamChunkRow {
  data: Uint8Array | null
  is_eof: number
}

function databaseUrl(sqlitePath: string): string {
  return `file:${sqlitePath.replaceAll('\\', '/')}`
}

function sqliteReader(sqlitePath: string) {
  const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  return new DatabaseSync(sqlitePath, {readOnly: true})
}

async function getEvent(
  sqlite: ReturnType<typeof createSqliteWorld>,
  runId: string,
  eventId: string,
  params?: GetEventParams,
): Promise<Event> {
  let cursor: string | undefined
  do {
    const page = await sqlite.events.list({
      runId,
      pagination: {
        limit: 1000,
        sortOrder: 'asc',
        ...(cursor ? {cursor} : {}),
      },
      ...(params?.resolveData ? {resolveData: params.resolveData} : {}),
    })
    const event = page.data.find((candidate) => candidate.eventId === eventId)
    if (event) {
      return event
    }
    cursor = page.cursor ?? undefined
  } while (cursor)

  throw new Error(`Workflow event ${eventId} was not found for run ${runId}.`)
}

function getStreamChunks(
  sqlitePath: string,
  name: string,
  options?: {limit?: number; cursor?: string},
): StreamChunksResponse {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000)
  const offset = options?.cursor ? Number.parseInt(options.cursor, 10) : 0
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Invalid stream cursor: ${options?.cursor ?? ''}`)
  }

  const database = sqliteReader(sqlitePath)
  try {
    const rows = database
      .prepare(
        `SELECT data, is_eof
         FROM stream_chunks
         WHERE stream_name = ?
         ORDER BY chunk_id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(name, limit + 1, offset) as unknown as StreamChunkRow[]
    const visibleRows = rows.filter((row) => row.is_eof === 0).slice(0, limit)
    const done = rows.some((row) => row.is_eof === 1)
    const hasMore = rows.filter((row) => row.is_eof === 0).length > limit
    return {
      data: visibleRows.map((row, index) => ({
        index: offset + index,
        data: row.data ? Uint8Array.from(row.data) : new Uint8Array(),
      })),
      cursor: hasMore ? String(offset + visibleRows.length) : null,
      hasMore,
      done,
    }
  } finally {
    database.close()
  }
}

function getStreamInfo(sqlitePath: string, name: string): StreamInfoResponse {
  const database = sqliteReader(sqlitePath)
  try {
    const row = database
      .prepare(
        `SELECT
          SUM(CASE WHEN is_eof = 0 THEN 1 ELSE 0 END) AS chunk_count,
          MAX(is_eof) AS done
        FROM stream_chunks
        WHERE stream_name = ?`,
      )
      .get(name) as {chunk_count: number | null; done: number | null}
    return {
      tailIndex: (row.chunk_count ?? 0) - 1,
      done: row.done === 1,
    }
  } finally {
    database.close()
  }
}

export function createDurableLocalWorld(
  config: Extract<WorldRuntimeConfig, {mode: 'local'}>,
  environment: NodeJS.ProcessEnv = process.env,
): World {
  const sqlite = createSqliteWorld({
    databaseUrl: databaseUrl(config.sqlitePath),
    baseUrl: config.baseUrl,
  })
  const nats = createNatsWorld({
    nats: {servers: [...config.natsUrls]},
    baseUrl: config.baseUrl,
    queueConcurrency: config.queueConcurrency,
    keyPrefix: 'ado_github_teams_',
    jobPrefix: 'ado_github_teams_',
  })

  const enqueue: World['queue'] = (queueName, message, opts) =>
    nats.queue(queueName, message, opts)

  const recoveryDisabled = environment.WORKFLOW_RECOVERY_DISABLED === 'true'
  let reconciler: StrandedRunReconcilerHandle | undefined

  const start = async (): Promise<void> => {
    await nats.start()
    if (recoveryDisabled) {
      return
    }
    // Startup recovery: re-enqueue every active run so a queue outage or a crash
    // between persist and enqueue cannot strand durably persisted work.
    await reenqueueActiveRuns(sqlite.runs, enqueue, RECONCILER_LABEL)
    // Steady-state safety net for the persist/enqueue gap that has no cross-store
    // transaction. Idempotent re-enqueue; the workflow handler replays its log.
    reconciler = startStrandedRunReconciler({
      runs: sqlite.runs,
      queue: enqueue,
      intervalMs: positiveIntEnv(environment, 'WORKFLOW_RECOVERY_INTERVAL_MS', 30_000),
      minAgeMs: positiveIntEnv(environment, 'WORKFLOW_RECOVERY_MIN_AGE_MS', 60_000),
      maxPerTick: positiveIntEnv(environment, 'WORKFLOW_RECOVERY_MAX_PER_TICK', 100),
      log: (message) => {
        console.log(`[${RECONCILER_LABEL}] ${message}`)
      },
    })
  }

  const close = async (): Promise<void> => {
    reconciler?.stop()
    reconciler = undefined
    await nats.close()
  }

  return {
    specVersion: nats.specVersion ?? SPEC_VERSION_CURRENT,
    runs: sqlite.runs,
    steps: sqlite.steps,
    hooks: sqlite.hooks,
    events: {
      create: sqlite.events.create.bind(sqlite.events),
      list: sqlite.events.list.bind(sqlite.events),
      listByCorrelationId:
        sqlite.events.listByCorrelationId.bind(sqlite.events),
      get: (runId, eventId, params) =>
        getEvent(sqlite, runId, eventId, params),
    },
    getDeploymentId: (...args) => nats.getDeploymentId(...args),
    queue: (...args) => nats.queue(...args),
    createQueueHandler: (...args) => nats.createQueueHandler(...args),
    writeToStream: (...args) => sqlite.writeToStream(...args),
    closeStream: (...args) => sqlite.closeStream(...args),
    readFromStream: (...args) => sqlite.readFromStream(...args),
    listStreamsByRunId: (...args) => sqlite.listStreamsByRunId(...args),
    getStreamChunks: (name, _runId, options) =>
      Promise.resolve(getStreamChunks(config.sqlitePath, name, options)),
    getStreamInfo: (name) =>
      Promise.resolve(getStreamInfo(config.sqlitePath, name)),
    start,
    close,
  }
}
