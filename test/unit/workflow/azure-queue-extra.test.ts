import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  createAzureDurableQueue,
  parseAzureQueueEnvelope,
  type AzureQueueEnvelope,
} from '../../../src/workflow/azure-queue.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const config = {
  starterUrl: 'https://functions.example/api/workflow-world/queue',
  deploymentId: 'deployment-1',
} as const

function parseRequestBody(init?: RequestInit): AzureQueueEnvelope {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected a JSON string request body.')
  }
  return JSON.parse(init.body) as AzureQueueEnvelope
}

function stubEchoFetch(): {readonly envelopes: readonly AzureQueueEnvelope[]} {
  const envelopes: AzureQueueEnvelope[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const envelope = parseRequestBody(init)
      envelopes.push(envelope)
      return Response.json({messageId: envelope.messageId}, {status: 202})
    }),
  )
  return {envelopes}
}

function delivery(headers: Record<string, string>, body: string | null): Request {
  return new Request('http://127.0.0.1/delivery', {
    method: 'POST',
    headers,
    ...(body === null ? {} : {body}),
  })
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the function to throw')
}

describe('createAzureDurableQueue.queue', () => {
  it('generates a random message ID and honours a positive delay', async () => {
    const {envelopes} = stubEchoFetch()
    const queue = createAzureDurableQueue(config)

    const result = await queue.queue(
      '__wkf_workflow_migrationWorkflow',
      {runId: 'run-1'},
      {
        delaySeconds: 15,
      },
    )

    expect(result.messageId).toMatch(/^msg_/)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.initialDelaySeconds).toBe(15)
    expect(envelopes[0]?.messageId).toBe(result.messageId)
  })

  it('clamps a negative delay to zero', async () => {
    const {envelopes} = stubEchoFetch()
    const queue = createAzureDurableQueue(config)

    await queue.queue('__wkf_workflow_migrationWorkflow', {runId: 'run-1'}, {delaySeconds: -3})

    expect(envelopes[0]?.initialDelaySeconds).toBe(0)
  })

  it('maps a fetch rejection to a bounded request-failed reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('tenant-specific network failure')
      }),
    )
    const queue = createAzureDurableQueue(config)

    await expect(
      queue.queue('__wkf_workflow_migrationWorkflow', {runId: 'run-1'}),
    ).rejects.toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'enqueue',
      reason: 'request-failed',
    })
  })

  it('rejects when the starter response omits the message ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, {status: 202})),
    )
    const queue = createAzureDurableQueue(config)

    await expect(
      queue.queue('__wkf_workflow_migrationWorkflow', {runId: 'run-1'}),
    ).rejects.toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'enqueue',
      reason: 'response-mismatch',
    })
  })

  it('rejects when the starter echoes a different message ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({messageId: 'msg_not_mine'}, {status: 202})),
    )
    const queue = createAzureDurableQueue(config)

    await expect(
      queue.queue('__wkf_workflow_migrationWorkflow', {runId: 'run-1'}),
    ).rejects.toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'enqueue',
      reason: 'response-mismatch',
    })
  })
})

describe('createAzureDurableQueue.createQueueHandler', () => {
  const queue = createAzureDurableQueue(config)

  it('returns 400 when queue metadata headers are missing', async () => {
    const handler = queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    const response = await handler(
      delivery({'x-a2g-queue-attempt': '1', 'x-a2g-message-id': 'msg_x'}, '{"runId":"run-1"}'),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({error: 'Missing Azure queue metadata'})
  })

  it('returns 400 when the request has no body', async () => {
    const handler = queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    const response = await handler(
      delivery(
        {
          'x-a2g-queue-name': '__wkf_workflow_x',
          'x-a2g-queue-attempt': '1',
          'x-a2g-message-id': 'msg_x',
        },
        null,
      ),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({error: 'Missing Azure queue metadata'})
  })

  it('returns 400 when the queue name is not a recognised queue name', async () => {
    const handler = queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    const response = await handler(
      delivery(
        {
          'x-a2g-queue-name': 'not_a_queue_name',
          'x-a2g-queue-attempt': '1',
          'x-a2g-message-id': 'msg_x',
        },
        '{"runId":"run-1"}',
      ),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({error: 'Invalid Azure queue metadata'})
  })

  it('returns 400 when a valid queue name does not match the handler prefix', async () => {
    const handler = queue.createQueueHandler('__wkf_step_', async () => undefined)
    const response = await handler(
      delivery(
        {
          'x-a2g-queue-name': '__wkf_workflow_x',
          'x-a2g-queue-attempt': '1',
          'x-a2g-message-id': 'msg_x',
        },
        '{"runId":"run-1"}',
      ),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({error: 'Invalid Azure queue delivery'})
  })

  it.each(['0', 'abc'])('returns 400 for an invalid attempt header %s', async (rawAttempt) => {
    const handler = queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    const response = await handler(
      delivery(
        {
          'x-a2g-queue-name': '__wkf_workflow_x',
          'x-a2g-queue-attempt': rawAttempt,
          'x-a2g-message-id': 'msg_x',
        },
        '{"runId":"run-1"}',
      ),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({error: 'Invalid Azure queue delivery'})
  })

  it('rejects when the payload body is not valid JSON', async () => {
    const handler = queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    await expect(
      handler(
        delivery(
          {
            'x-a2g-queue-name': '__wkf_workflow_x',
            'x-a2g-queue-attempt': '1',
            'x-a2g-message-id': 'msg_x',
          },
          '{not json',
        ),
      ),
    ).rejects.toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'decode',
      reason: 'invalid-json',
    })
  })

  it('rejects when the payload is valid JSON but not a queue payload', async () => {
    const handler = queue.createQueueHandler('__wkf_workflow_', async () => undefined)
    await expect(
      handler(
        delivery(
          {
            'x-a2g-queue-name': '__wkf_workflow_x',
            'x-a2g-queue-attempt': '1',
            'x-a2g-message-id': 'msg_x',
          },
          '{"totally":"wrong"}',
        ),
      ),
    ).rejects.toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'decode',
      reason: 'schema-mismatch',
    })
  })

  it('responds with ok when the handler returns no continuation', async () => {
    let received: unknown
    const handler = queue.createQueueHandler('__wkf_workflow_', async (payload) => {
      received = payload
    })
    const response = await handler(
      delivery(
        {
          'x-a2g-queue-name': '__wkf_workflow_x',
          'x-a2g-queue-attempt': '2',
          'x-a2g-message-id': 'msg_x',
        },
        '{"runId":"run-1"}',
      ),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ok: true})
    expect(received).toEqual({runId: 'run-1'})
  })

  it('clamps a negative continuation timeout to zero', async () => {
    const handler = queue.createQueueHandler('__wkf_workflow_', async () => ({timeoutSeconds: -5}))
    const response = await handler(
      delivery(
        {
          'x-a2g-queue-name': '__wkf_workflow_x',
          'x-a2g-queue-attempt': '1',
          'x-a2g-message-id': 'msg_x',
        },
        '{"runId":"run-1"}',
      ),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({timeoutSeconds: 0})
  })
})

describe('createAzureDurableQueue.getDeploymentId', () => {
  it('resolves the configured deployment ID', async () => {
    const queue = createAzureDurableQueue(config)
    await expect(queue.getDeploymentId()).resolves.toBe('deployment-1')
  })
})

describe('parseAzureQueueEnvelope', () => {
  it('returns the decoded envelope for a well-formed value', () => {
    const envelope = {
      queueName: '__wkf_workflow_x',
      messageId: 'msg_x',
      payload: '{"runId":"run-1"}',
      initialDelaySeconds: 0,
    }
    expect(parseAzureQueueEnvelope(envelope)).toEqual(envelope)
  })

  it('throws a schema-mismatch failure for a malformed envelope', () => {
    expect(thrownBy(() => parseAzureQueueEnvelope({}))).toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'decode',
      reason: 'schema-mismatch',
    })
  })

  it('throws an invalid-delay failure for a negative delay', () => {
    expect(
      thrownBy(() =>
        parseAzureQueueEnvelope({
          queueName: '__wkf_workflow_x',
          messageId: 'msg_x',
          payload: '{}',
          initialDelaySeconds: -5,
        }),
      ),
    ).toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'decode',
      reason: 'invalid-delay',
    })
  })

  it('throws a tagged schema-mismatch failure for an unrecognised queue name', () => {
    // Regression: this used `ValidQueueName.parse(...)`, which threw a raw ZodError — the only
    // untagged rejection in a decoder whose every other failure is an AzureDurableWorldFailure.
    // A caller matching on the tagged failure silently missed a malformed queue name.
    expect(
      thrownBy(() =>
        parseAzureQueueEnvelope({
          queueName: 'not_a_queue_name',
          messageId: 'msg_x',
          payload: '{}',
          initialDelaySeconds: 0,
        }),
      ),
    ).toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'decode',
      reason: 'schema-mismatch',
    })
  })
})
