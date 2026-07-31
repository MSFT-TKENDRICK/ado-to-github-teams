import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {Either, Schema} from 'effect'
import * as df from 'durable-functions'
import {setWorld} from 'workflow/runtime'
import {resolveWorldRuntimeConfig} from '../workflow/config.js'
import {parseAzureQueueEnvelope, type AzureQueueEnvelope} from '../workflow/azure-queue.js'
import {createAzureDurableWorld} from '../workflow/world.js'

const orchestrationName = 'a2gWorkflowWorldQueue'
const activityName = 'a2gWorkflowWorldDelivery'
const maxDeliveries = 48
const retryDelayMs = 5_000

const QueueDeliveryResultSchema = Schema.Struct({
  timeoutSeconds: Schema.optional(Schema.Number),
})

type QueueDeliveryResult = typeof QueueDeliveryResultSchema.Type

interface QueueDeliveryInput {
  readonly envelope: AzureQueueEnvelope
  readonly attempt: number
}

interface WorkflowBundle {
  readonly POST: (request: Request) => Promise<Response>
}

const runtimeConfig = resolveWorldRuntimeConfig()
if (runtimeConfig.mode !== 'azure') {
  throw new Error('Azure Functions require WORKFLOW_TARGET_WORLD=azure.')
}
setWorld(createAzureDurableWorld(runtimeConfig))

function bundlePath(name: 'steps.mjs' | 'workflows.mjs'): string {
  const root =
    process.env.WORKFLOW_BUNDLE_DIR ??
    path.resolve(process.cwd(), '.workflow-data', 'build', 'workflow')
  return path.join(root, name)
}

async function loadBundle(queueName: string): Promise<WorkflowBundle> {
  const file = queueName.includes('_wkf_step_') ? 'steps.mjs' : 'workflows.mjs'
  const loaded = (await import(pathToFileURL(bundlePath(file)).href)) as {
    readonly POST?: unknown
  }
  if (typeof loaded.POST !== 'function') {
    throw new Error(`Workflow bundle ${file} does not export a POST handler.`)
  }
  return loaded as WorkflowBundle
}

export async function deliverAzureQueueMessage(rawInput: unknown): Promise<QueueDeliveryResult> {
  const input = rawInput as Partial<QueueDeliveryInput>
  const envelope = parseAzureQueueEnvelope(input.envelope)
  if (!Number.isSafeInteger(input.attempt) || (input.attempt ?? 0) < 1) {
    throw new Error('Azure queue delivery attempt must be a positive integer.')
  }
  const bundle = await loadBundle(envelope.queueName)
  const response = await bundle.POST(
    new Request('http://127.0.0.1/.well-known/workflow/v1/delivery', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-a2g-message-id': envelope.messageId,
        'x-a2g-queue-attempt': String(input.attempt),
        'x-a2g-queue-name': envelope.queueName,
      },
      body: envelope.payload,
    }),
  )
  if (!response.ok) {
    throw new Error(`Workflow queue delivery failed with HTTP ${response.status}.`)
  }
  const decoded = Schema.decodeUnknownEither(QueueDeliveryResultSchema)(await response.json())
  if (Either.isLeft(decoded)) {
    throw new Error('Workflow queue delivery returned an invalid response.')
  }
  return decoded.right
}

df.app.activity(activityName, {
  handler: deliverAzureQueueMessage,
})

df.app.orchestration(orchestrationName, function* (context) {
  const envelope = parseAzureQueueEnvelope(context.df.getInput())
  if (envelope.initialDelaySeconds > 0) {
    const resumeAt = new Date(
      context.df.currentUtcDateTime.getTime() + envelope.initialDelaySeconds * 1_000,
    )
    yield context.df.createTimer(resumeAt)
  }

  for (let attempt = 1; attempt <= maxDeliveries; attempt += 1) {
    try {
      const result = (yield context.df.callActivity(activityName, {
        envelope,
        attempt,
      } satisfies QueueDeliveryInput)) as QueueDeliveryResult
      if (typeof result.timeoutSeconds !== 'number') {
        return {messageId: envelope.messageId, deliveries: attempt}
      }
      const resumeAt = new Date(
        context.df.currentUtcDateTime.getTime() + Math.max(0, result.timeoutSeconds) * 1_000,
      )
      yield context.df.createTimer(resumeAt)
    } catch (error) {
      if (attempt === maxDeliveries) {
        throw error
      }
      const retryAt = new Date(context.df.currentUtcDateTime.getTime() + retryDelayMs)
      yield context.df.createTimer(retryAt)
    }
  }
  throw new Error('Workflow queue delivery exhausted its finite retry budget.')
})

df.app.client.http('a2gWorkflowWorldQueueStart', {
  route: 'workflow-world/queue',
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, client) => {
    const envelope = parseAzureQueueEnvelope(await request.json())
    const existing = await client.getStatus(envelope.messageId)
    if (existing) {
      return {status: 202, jsonBody: {messageId: envelope.messageId}}
    }
    const instanceId = await client.startNew(orchestrationName, {
      instanceId: envelope.messageId,
      input: envelope,
    })
    return {status: 202, jsonBody: {messageId: instanceId}}
  },
})
