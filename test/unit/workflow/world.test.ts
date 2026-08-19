import http from 'node:http'
import {mkdtempSync, rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import type {AddressInfo} from 'node:net'
import path from 'node:path'
import {SPEC_VERSION_CURRENT} from '@workflow/world'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'

const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

const hoisted = vi.hoisted(() => {
  const eventsCreate = vi.fn()
  const eventsList = vi.fn()
  const eventsListByCorrelationId = vi.fn()
  const writeToStream = vi.fn()
  const closeStream = vi.fn()
  const readFromStream = vi.fn()
  const listStreamsByRunId = vi.fn()
  const sqlite = {
    runs: {marker: 'runs'},
    steps: {marker: 'steps'},
    hooks: {marker: 'hooks'},
    events: {
      create: eventsCreate,
      list: eventsList,
      listByCorrelationId: eventsListByCorrelationId,
    },
    writeToStream,
    closeStream,
    readFromStream,
    listStreamsByRunId,
  }
  const tursoCreateWorld = vi.fn(() => sqlite)

  const natsQueue = vi.fn()
  const natsGetDeploymentId = vi.fn()
  const natsCreateQueueHandler = vi.fn()
  const natsStart = vi.fn()
  const natsClose = vi.fn()
  const natsWorld: {
    specVersion: number | undefined
    queue: typeof natsQueue
    getDeploymentId: typeof natsGetDeploymentId
    createQueueHandler: typeof natsCreateQueueHandler
    start: typeof natsStart
    close: typeof natsClose
  } = {
    specVersion: undefined,
    queue: natsQueue,
    getDeploymentId: natsGetDeploymentId,
    createQueueHandler: natsCreateQueueHandler,
    start: natsStart,
    close: natsClose,
  }
  const natsCreateWorld = vi.fn(() => natsWorld)

  return {
    sqlite,
    tursoCreateWorld,
    natsWorld,
    natsCreateWorld,
    eventsCreate,
    eventsList,
    eventsListByCorrelationId,
    writeToStream,
    closeStream,
    readFromStream,
    listStreamsByRunId,
    natsQueue,
    natsGetDeploymentId,
    natsCreateQueueHandler,
    natsStart,
    natsClose,
  }
})

vi.mock('@workflow-worlds/turso', () => ({createWorld: hoisted.tursoCreateWorld}))
vi.mock('@fantasticfour/world-nats-jetstream', () => ({createWorld: hoisted.natsCreateWorld}))

const {createAzureDurableWorld, createDurableLocalWorld} =
  await import('../../../src/workflow/world.js')

const scratchDirs: string[] = []
const sharedScratchDir = mkdtempSync(path.join(process.cwd(), 'wf-world-'))
scratchDirs.push(sharedScratchDir)
let databaseCounter = 0

interface SeedRow {
  readonly stream: string
  readonly chunkId: number
  readonly data: Uint8Array | null
  readonly eof: boolean
}

function seedStreamDatabase(rows: readonly SeedRow[]): string {
  const databasePath = path.join(sharedScratchDir, `streams-${databaseCounter++}.db`)
  const database = new DatabaseSync(databasePath)
  database.exec(
    'CREATE TABLE stream_chunks (stream_name TEXT NOT NULL, chunk_id INTEGER NOT NULL, data BLOB, is_eof INTEGER NOT NULL)',
  )
  const insert = database.prepare(
    'INSERT INTO stream_chunks (stream_name, chunk_id, data, is_eof) VALUES (?, ?, ?, ?)',
  )
  for (const row of rows) {
    insert.run(row.stream, row.chunkId, row.data, row.eof ? 1 : 0)
  }
  database.close()
  return databasePath
}

function unusedDatabasePath(): string {
  return path.join(sharedScratchDir, 'unused.db')
}

function makeLocalWorld(sqlitePath: string, environment: NodeJS.ProcessEnv = {}) {
  return createDurableLocalWorld(
    {
      mode: 'local',
      sqlitePath,
      natsUrls: ['nats://127.0.0.1:4222'],
      baseUrl: 'http://127.0.0.1:7331',
      queueConcurrency: 10,
    },
    environment,
  )
}

interface EchoServer {
  readonly url: string
  readonly envelopes: () => ReadonlyArray<{queueName?: string; messageId?: string}>
  readonly close: () => Promise<void>
}

async function startEchoServer(): Promise<EchoServer> {
  const seen: Array<{queueName?: string; messageId?: string}> = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        queueName?: string
        messageId?: string
      }
      seen.push(parsed)
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify({messageId: parsed.messageId}))
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    envelopes: () => [...seen],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.natsWorld.specVersion = undefined
})

afterAll(() => {
  for (const directory of scratchDirs) {
    rmSync(directory, {recursive: true, force: true})
  }
})

describe('createDurableLocalWorld', () => {
  it('constructs the sqlite and NATS worlds from the local configuration', () => {
    const sqlitePath = unusedDatabasePath()

    const world = makeLocalWorld(sqlitePath)

    expect(world.runs).toBe(hoisted.sqlite.runs)
    expect(world.steps).toBe(hoisted.sqlite.steps)
    expect(world.hooks).toBe(hoisted.sqlite.hooks)
    expect(hoisted.tursoCreateWorld).toHaveBeenCalledWith({
      databaseUrl: `file:${sqlitePath.replaceAll('\\', '/')}`,
      baseUrl: 'http://127.0.0.1:7331',
    })
    expect(hoisted.natsCreateWorld).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: 'ado_github_teams_',
        jobPrefix: 'ado_github_teams_',
        queueConcurrency: 10,
        baseUrl: 'http://127.0.0.1:7331',
      }),
    )
  })

  it('exposes the current spec version when the queue world does not report one', () => {
    const world = makeLocalWorld(unusedDatabasePath())

    expect(world.specVersion).toBe(SPEC_VERSION_CURRENT)
  })

  it('adopts the queue world spec version when it reports one', () => {
    hoisted.natsWorld.specVersion = 7

    const world = makeLocalWorld(unusedDatabasePath())

    expect(world.specVersion).toBe(7)
  })

  it('returns visible chunks and marks the stream done when an EOF marker is present', async () => {
    const sqlitePath = seedStreamDatabase([
      {stream: 'events', chunkId: 0, data: Uint8Array.from([1, 2, 3]), eof: false},
      {stream: 'events', chunkId: 1, data: Uint8Array.from([4, 5]), eof: false},
      {stream: 'events', chunkId: 2, data: null, eof: true},
    ])
    const world = makeLocalWorld(sqlitePath)

    const response = await world.getStreamChunks('events', 'run-1', {limit: 100})

    expect(response.done).toBe(true)
    expect(response.hasMore).toBe(false)
    expect(response.cursor).toBeNull()
    expect(response.data).toEqual([
      {index: 0, data: Uint8Array.from([1, 2, 3])},
      {index: 1, data: Uint8Array.from([4, 5])},
    ])
  })

  it('paginates available chunks with an opaque cursor when no EOF is present', async () => {
    const sqlitePath = seedStreamDatabase([
      {stream: 'log', chunkId: 0, data: Uint8Array.from([10]), eof: false},
      {stream: 'log', chunkId: 1, data: Uint8Array.from([11]), eof: false},
      {stream: 'log', chunkId: 2, data: Uint8Array.from([12]), eof: false},
    ])
    const world = makeLocalWorld(sqlitePath)

    const first = await world.getStreamChunks('log', 'run-1', {limit: 2})
    expect(first.data.map((chunk) => chunk.index)).toEqual([0, 1])
    expect(first.hasMore).toBe(true)
    expect(first.cursor).toBe('2')
    expect(first.done).toBe(false)

    const second = await world.getStreamChunks('log', 'run-1', {
      limit: 2,
      // `exactOptionalPropertyTypes` forbids passing an explicit `undefined` for an optional
      // property, so the key is spread in only when a cursor was actually returned.
      ...(first.cursor === null ? {} : {cursor: first.cursor}),
    })
    expect(second.data.map((chunk) => chunk.index)).toEqual([2])
    expect(second.hasMore).toBe(false)
    expect(second.cursor).toBeNull()
  })

  it('rejects a malformed stream cursor', () => {
    const world = makeLocalWorld(unusedDatabasePath())

    expect(() => world.getStreamChunks('log', 'run-1', {cursor: 'not-a-number'})).toThrow(
      'Invalid stream cursor',
    )
  })

  it('reports the tail index and completion for a populated stream', async () => {
    const sqlitePath = seedStreamDatabase([
      {stream: 's', chunkId: 0, data: Uint8Array.from([1]), eof: false},
      {stream: 's', chunkId: 1, data: Uint8Array.from([2]), eof: false},
      {stream: 's', chunkId: 2, data: null, eof: true},
    ])
    const world = makeLocalWorld(sqlitePath)

    expect(await world.getStreamInfo('s', 'run-1')).toEqual({tailIndex: 1, done: true})
  })

  it('reports an empty stream as not started and not done', async () => {
    const sqlitePath = seedStreamDatabase([])
    const world = makeLocalWorld(sqlitePath)

    expect(await world.getStreamInfo('missing', 'run-1')).toEqual({tailIndex: -1, done: false})
  })

  it('resolves an event by id from a single page and forwards resolveData', async () => {
    hoisted.eventsList.mockReset()
    hoisted.eventsList.mockResolvedValueOnce({
      data: [{eventId: 'evt-1'}, {eventId: 'evt-2'}],
      cursor: null,
      hasMore: false,
    })
    const world = makeLocalWorld(unusedDatabasePath())

    const event = await world.events.get('run-1', 'evt-2', {resolveData: 'all'})

    expect(event.eventId).toBe('evt-2')
    expect(hoisted.eventsList).toHaveBeenCalledWith({
      runId: 'run-1',
      pagination: {limit: 1000, sortOrder: 'asc'},
      resolveData: 'all',
    })
  })

  it('walks pages using the cursor until it finds the event', async () => {
    hoisted.eventsList.mockReset()
    hoisted.eventsList
      .mockResolvedValueOnce({data: [{eventId: 'a'}], cursor: 'cursor-2', hasMore: true})
      .mockResolvedValueOnce({data: [{eventId: 'b'}], cursor: null, hasMore: false})
    const world = makeLocalWorld(unusedDatabasePath())

    const event = await world.events.get('run-9', 'b')

    expect(event.eventId).toBe('b')
    expect(hoisted.eventsList).toHaveBeenNthCalledWith(1, {
      runId: 'run-9',
      pagination: {limit: 1000, sortOrder: 'asc'},
    })
    expect(hoisted.eventsList).toHaveBeenNthCalledWith(2, {
      runId: 'run-9',
      pagination: {limit: 1000, sortOrder: 'asc', cursor: 'cursor-2'},
    })
  })

  it('throws when the event is absent after exhausting all pages', async () => {
    hoisted.eventsList.mockReset()
    hoisted.eventsList.mockResolvedValueOnce({data: [{eventId: 'x'}], cursor: null, hasMore: false})
    const world = makeLocalWorld(unusedDatabasePath())

    await expect(world.events.get('run-1', 'missing')).rejects.toThrow(
      'Workflow event missing was not found for run run-1',
    )
  })

  it('delegates event creation and listing to the sqlite storage', async () => {
    hoisted.eventsCreate.mockReset()
    hoisted.eventsCreate.mockResolvedValue({event: {eventId: 'evt-1'}})
    hoisted.eventsList.mockReset()
    hoisted.eventsList.mockResolvedValue({data: [], cursor: null, hasMore: false})
    const world = makeLocalWorld(unusedDatabasePath())

    const created = await world.events.create('run-1', {
      eventType: 'step_started',
      correlationId: 'corr-1',
    })
    expect(created).toEqual({event: {eventId: 'evt-1'}})
    expect(hoisted.eventsCreate).toHaveBeenCalledWith('run-1', {
      eventType: 'step_started',
      correlationId: 'corr-1',
    })

    await world.events.list({runId: 'run-1'})
    expect(hoisted.eventsList).toHaveBeenCalledWith({runId: 'run-1'})

    await world.events.listByCorrelationId({correlationId: 'corr-1'})
    expect(hoisted.eventsListByCorrelationId).toHaveBeenCalledWith({correlationId: 'corr-1'})
  })

  it('delegates queue, deployment, and handler operations to the NATS world', async () => {
    hoisted.natsQueue.mockResolvedValue({messageId: 'msg_delegated'})
    hoisted.natsGetDeploymentId.mockResolvedValue('deploy-nats')
    const handlerFn = vi.fn()
    hoisted.natsCreateQueueHandler.mockReturnValue(handlerFn)
    const world = makeLocalWorld(unusedDatabasePath())

    const message = {runId: 'run-1'}
    const queued = await world.queue('__wkf_workflow_migrationWorkflow', message, {
      idempotencyKey: 'k',
    })
    expect(queued).toEqual({messageId: 'msg_delegated'})
    expect(hoisted.natsQueue).toHaveBeenCalledWith('__wkf_workflow_migrationWorkflow', message, {
      idempotencyKey: 'k',
    })

    expect(await world.getDeploymentId()).toBe('deploy-nats')

    const handler = async (): Promise<void> => undefined
    expect(world.createQueueHandler('__wkf_workflow_', handler)).toBe(handlerFn)
    expect(hoisted.natsCreateQueueHandler).toHaveBeenCalledWith('__wkf_workflow_', handler)
  })

  it('delegates stream lifecycle operations to the sqlite storage', async () => {
    const sentinel = new ReadableStream<Uint8Array>()
    hoisted.readFromStream.mockResolvedValue(sentinel)
    hoisted.listStreamsByRunId.mockResolvedValue(['stream-a'])
    const world = makeLocalWorld(unusedDatabasePath())

    await world.writeToStream('name', 'run-1', Uint8Array.from([1]))
    expect(hoisted.writeToStream).toHaveBeenCalledWith('name', 'run-1', Uint8Array.from([1]))

    await world.closeStream('name', 'run-1')
    expect(hoisted.closeStream).toHaveBeenCalledWith('name', 'run-1')

    expect(await world.readFromStream('name', 2)).toBe(sentinel)
    expect(hoisted.readFromStream).toHaveBeenCalledWith('name', 2)

    expect(await world.listStreamsByRunId('run-1')).toEqual(['stream-a'])
    expect(hoisted.listStreamsByRunId).toHaveBeenCalledWith('run-1')
  })

  it('closes the NATS world on close', async () => {
    const world = makeLocalWorld(unusedDatabasePath())

    await world.close?.()

    expect(hoisted.natsClose).toHaveBeenCalledOnce()
  })

  it('starts NATS and short-circuits when recovery is disabled', async () => {
    const world = makeLocalWorld(unusedDatabasePath(), {WORKFLOW_RECOVERY_DISABLED: 'true'})

    await world.start?.()

    expect(hoisted.natsStart).toHaveBeenCalledOnce()
  })

  it('logs the enforced backup topology before starting in production', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const world = makeLocalWorld(unusedDatabasePath(), {
        APP_ENV: 'production',
        WORKFLOW_RECOVERY_DISABLED: 'true',
        WORKFLOW_JETSTREAM_REPLICAS: '3',
        WORKFLOW_JETSTREAM_RETENTION: 'workqueue',
        WORKFLOW_JETSTREAM_MAX_MSGS: '100000',
      })

      await world.start?.()

      expect(hoisted.natsStart).toHaveBeenCalledOnce()
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('backup topology'))
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('createAzureDurableWorld', () => {
  function makeAzureWorld(starterUrl: string) {
    return createAzureDurableWorld({
      mode: 'azure',
      databaseUrl: 'https://db.example',
      databaseAuthToken: 'token',
      starterUrl,
      deploymentId: 'deploy-42',
      baseUrl: 'https://base.example',
    })
  }

  it('resolves the configured deployment id and constructs storage with the auth token', async () => {
    const world = makeAzureWorld('https://starter.example')

    expect(await world.getDeploymentId()).toBe('deploy-42')
    expect(hoisted.tursoCreateWorld).toHaveBeenCalledWith({
      databaseUrl: 'https://db.example',
      authToken: 'token',
      baseUrl: 'https://base.example',
    })
  })

  it('starts as a no-op', async () => {
    const world = makeAzureWorld('https://starter.example')

    await expect(world.start?.()).resolves.toBeUndefined()
  })

  it('builds an Azure queue handler for a valid prefix', () => {
    const world = makeAzureWorld('https://starter.example')

    const handler = world.createQueueHandler(
      '__wkf_workflow_',
      async (): Promise<void> => undefined,
    )

    expect(handler).toBeTypeOf('function')
  })

  it('delegates queue enqueue to the Azure durable starter endpoint', async () => {
    const echo = await startEchoServer()
    try {
      const world = makeAzureWorld(echo.url)

      const result = await world.queue(
        '__wkf_workflow_migrationWorkflow',
        {runId: 'run-1'},
        {idempotencyKey: 'k'},
      )

      const [envelope] = echo.envelopes()
      expect(envelope?.queueName).toBe('__wkf_workflow_migrationWorkflow')
      expect(envelope?.messageId ?? '').toMatch(/^msg_/)
      expect(result.messageId).toBe(envelope?.messageId)
    } finally {
      await echo.close()
    }
  })
})
