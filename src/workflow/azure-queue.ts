import {createHash, randomUUID} from 'node:crypto'
import {Data, Either, Schema} from 'effect'
import {
  MessageId,
  QueuePayloadSchema,
  QueuePrefix,
  ValidQueueName,
  type Queue,
  type QueueOptions,
  type QueuePayload,
} from '@workflow/world'

const encodedBytesTag = 'Uint8Array'

const AzureQueueResponseSchema = Schema.Struct({
  messageId: Schema.String,
})

export const AzureQueueEnvelopeSchema = Schema.Struct({
  queueName: Schema.String,
  messageId: Schema.String,
  payload: Schema.String,
  initialDelaySeconds: Schema.Number,
})

export type AzureQueueEnvelope = typeof AzureQueueEnvelopeSchema.Type

export class AzureDurableWorldFailure extends Data.TaggedError('AzureDurableWorldFailure')<{
  readonly operation: 'enqueue' | 'decode'
  readonly reason: string
}> {}

function encodePayload(value: QueuePayload): string {
  return JSON.stringify(value, (_key, candidate: unknown) =>
    candidate instanceof Uint8Array
      ? {__type: encodedBytesTag, data: Buffer.from(candidate).toString('base64')}
      : candidate,
  )
}

function decodePayload(value: string): QueuePayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value, (_key, candidate: unknown) => {
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        '__type' in candidate &&
        candidate.__type === encodedBytesTag &&
        'data' in candidate &&
        typeof candidate.data === 'string'
      ) {
        return Uint8Array.from(Buffer.from(candidate.data, 'base64'))
      }
      return candidate
    })
  } catch {
    throw new AzureDurableWorldFailure({
      operation: 'decode',
      reason: 'invalid-json',
    })
  }
  const decoded = QueuePayloadSchema.safeParse(parsed)
  if (!decoded.success) {
    throw new AzureDurableWorldFailure({
      operation: 'decode',
      reason: 'schema-mismatch',
    })
  }
  return decoded.data
}

function decodeEnvelope(value: unknown): AzureQueueEnvelope {
  const decoded = Schema.decodeUnknownEither(AzureQueueEnvelopeSchema)(value)
  if (Either.isLeft(decoded)) {
    throw new AzureDurableWorldFailure({
      operation: 'decode',
      reason: 'schema-mismatch',
    })
  }
  ValidQueueName.parse(decoded.right.queueName)
  MessageId.parse(decoded.right.messageId)
  if (
    !Number.isFinite(decoded.right.initialDelaySeconds) ||
    decoded.right.initialDelaySeconds < 0
  ) {
    throw new AzureDurableWorldFailure({
      operation: 'decode',
      reason: 'invalid-delay',
    })
  }
  return decoded.right
}

function messageId(queueName: string, options?: QueueOptions): string {
  if (!options?.idempotencyKey) {
    return `msg_${randomUUID()}`
  }
  const digest = createHash('sha256')
    .update(queueName)
    .update('\0')
    .update(options.idempotencyKey)
    .digest('hex')
  return `msg_${digest}`
}

function boundedResponseReason(status: number): string {
  return `http-${status}`
}

export interface AzureDurableQueueConfig {
  readonly starterUrl: string
  readonly deploymentId: string
}

export function createAzureDurableQueue(config: AzureDurableQueueConfig): Queue {
  const queue: Queue['queue'] = async (queueName, message, options) => {
    const id = MessageId.parse(messageId(queueName, options))
    const envelope: AzureQueueEnvelope = {
      queueName,
      messageId: id,
      payload: encodePayload(message),
      initialDelaySeconds: Math.max(0, options?.delaySeconds ?? 0),
    }
    let response: Response
    try {
      response = await fetch(config.starterUrl, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new AzureDurableWorldFailure({
        operation: 'enqueue',
        reason: 'request-failed',
      })
    }
    if (!response.ok) {
      throw new AzureDurableWorldFailure({
        operation: 'enqueue',
        reason: boundedResponseReason(response.status),
      })
    }
    const decoded = Schema.decodeUnknownEither(AzureQueueResponseSchema)(await response.json())
    if (Either.isLeft(decoded) || decoded.right.messageId !== id) {
      throw new AzureDurableWorldFailure({
        operation: 'enqueue',
        reason: 'response-mismatch',
      })
    }
    return {messageId: id}
  }

  const createQueueHandler: Queue['createQueueHandler'] = (prefix, handler) => {
    QueuePrefix.parse(prefix)
    return async (request) => {
      const queueName = request.headers.get('x-a2g-queue-name')
      const rawAttempt = request.headers.get('x-a2g-queue-attempt')
      const id = request.headers.get('x-a2g-message-id')
      if (!queueName || !rawAttempt || !id || !request.body) {
        return Response.json({error: 'Missing Azure queue metadata'}, {status: 400})
      }
      let validQueueName: ReturnType<typeof ValidQueueName.parse>
      let validMessageId: ReturnType<typeof MessageId.parse>
      try {
        validQueueName = ValidQueueName.parse(queueName)
        validMessageId = MessageId.parse(id)
      } catch {
        return Response.json({error: 'Invalid Azure queue metadata'}, {status: 400})
      }
      const attempt = Number.parseInt(rawAttempt, 10)
      if (!validQueueName.startsWith(prefix) || !Number.isSafeInteger(attempt) || attempt < 1) {
        return Response.json({error: 'Invalid Azure queue delivery'}, {status: 400})
      }
      const payload = decodePayload(await new Response(request.body).text())
      const result = await handler(payload, {
        attempt,
        queueName: validQueueName,
        messageId: validMessageId,
      })
      return typeof result?.timeoutSeconds === 'number'
        ? Response.json({timeoutSeconds: Math.max(0, result.timeoutSeconds)})
        : Response.json({ok: true})
    }
  }

  return {
    queue,
    createQueueHandler,
    getDeploymentId: () => Promise.resolve(config.deploymentId),
  }
}

export function parseAzureQueueEnvelope(value: unknown): AzureQueueEnvelope {
  return decodeEnvelope(value)
}
