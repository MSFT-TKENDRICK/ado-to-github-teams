import {afterEach, describe, expect, it, vi} from 'vitest'
import {createAzureDurableQueue} from '../../../src/workflow/azure-queue.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function parseRequestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected a JSON string request body.')
  }
  return JSON.parse(init.body)
}

describe('Azure Durable Functions World queue', () => {
  it('starts a durable orchestration with a stable idempotent message ID', async () => {
    const requests: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const request = parseRequestBody(init) as {messageId: string}
        requests.push(request)
        return Response.json({messageId: request.messageId}, {status: 202})
      }),
    )
    const queue = createAzureDurableQueue({
      starterUrl: 'https://functions.example/api/workflow-world/queue',
      deploymentId: 'deployment-1',
    })
    const payload = {runId: 'run-1'}

    const first = await queue.queue('__wkf_workflow_migrationWorkflow', payload, {
      idempotencyKey: 'run-1',
    })
    const second = await queue.queue('__wkf_workflow_migrationWorkflow', payload, {
      idempotencyKey: 'run-1',
    })

    expect(first.messageId).toBe(second.messageId)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      queueName: '__wkf_workflow_migrationWorkflow',
      messageId: first.messageId,
      initialDelaySeconds: 0,
    })
  })

  it('preserves binary workflow input through the activity handler boundary', async () => {
    const queue = createAzureDurableQueue({
      starterUrl: 'https://functions.example/api/workflow-world/queue',
      deploymentId: 'deployment-1',
    })
    let received: unknown
    const handler = queue.createQueueHandler('__wkf_workflow_', async (payload) => {
      received = payload
      return {timeoutSeconds: 3}
    })
    const payload = {
      runId: 'run-1',
      runInput: {
        input: Uint8Array.from([1, 2, 3]),
        deploymentId: 'deployment-1',
        workflowName: 'migrationWorkflow',
        specVersion: 3,
      },
    }
    let envelope: {payload: string; messageId: string}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        envelope = parseRequestBody(init) as typeof envelope
        return Response.json({messageId: envelope.messageId}, {status: 202})
      }),
    )
    await queue.queue('__wkf_workflow_migrationWorkflow', payload)

    const response = await handler(
      new Request('http://127.0.0.1/delivery', {
        method: 'POST',
        headers: {
          'x-a2g-message-id': envelope!.messageId,
          'x-a2g-queue-attempt': '1',
          'x-a2g-queue-name': '__wkf_workflow_migrationWorkflow',
        },
        body: envelope!.payload,
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({timeoutSeconds: 3})
    expect(received).toMatchObject(payload)
    expect((received as typeof payload).runInput.input).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it('surfaces bounded HTTP failure reasons without response content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('tenant-specific failure', {status: 503})),
    )
    const queue = createAzureDurableQueue({
      starterUrl: 'https://functions.example/api/workflow-world/queue',
      deploymentId: 'deployment-1',
    })

    await expect(
      queue.queue('__wkf_workflow_migrationWorkflow', {runId: 'run-1'}),
    ).rejects.toMatchObject({
      _tag: 'AzureDurableWorldFailure',
      operation: 'enqueue',
      reason: 'http-503',
    })
  })
})
