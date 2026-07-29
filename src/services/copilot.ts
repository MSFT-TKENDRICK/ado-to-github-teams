import {randomUUID} from 'node:crypto'
import {
  CopilotClient,
  type CopilotClientOptions,
  type MessageOptions,
  type PermissionHandler,
  type SessionConfig,
} from '@github/copilot-sdk'
import {Effect, Layer} from 'effect'
import {
  decodeHealingInferenceDecision,
  type HealingInferenceRequest,
} from '../effect/healing.js'
import {HealingInferenceFailure} from '../effect/errors.js'
import {HealingReasonerTag} from '../effect/services.js'
import type {AgentTraceIdentity} from '../types/index.js'

const HEALING_SYSTEM_MESSAGE = `You are a safety classifier for a resumable identity migration.
Evaluate only the supplied failure and operation metadata. Never invoke tools or assume an external
write failed or succeeded without evidence. Prefer abort or escalate when prerequisites are missing.
Return only one JSON object with exactly these fields:
{"action":"retry|skip|abort|escalate","confidence":0.0,"safeToAutomate":false,
"rationale":"...","risk":"...","prerequisites":["..."]}`

export interface CopilotSdkSessionLike {
  /** Real, durable session ID from `CopilotSession#sessionId`, resumable via `CopilotClient.resumeSession`. */
  readonly sessionId: string
  readonly sendAndWait: (
    options: MessageOptions,
    timeout?: number,
  ) => Promise<
    | {
        readonly id: string
        readonly data: {readonly content: string; readonly messageId: string}
      }
    | undefined
  >
  readonly disconnect: () => Promise<void>
}

export interface CopilotSdkClientLike {
  readonly start: () => Promise<void>
  readonly createSession: (config: SessionConfig) => Promise<CopilotSdkSessionLike>
  readonly stop: () => Promise<Error[]>
  readonly forceStop: () => Promise<void>
}

export type CopilotSdkClientFactory = (
  options: CopilotClientOptions,
) => CopilotSdkClientLike

export interface CopilotCompletion {
  readonly complete: (
    request: CopilotCompletionRequest,
  ) => Promise<CopilotCompletionResponse>
}

export interface CopilotCompletionRequest {
  readonly prompt: string
  /** Process-local correlation ID for this attempt, used only if the SDK exposes no session ID. */
  readonly localCorrelationId: string
}

export interface CopilotCompletionResponse {
  readonly content: string
  readonly trace: AgentTraceIdentity
}

const rejectToolUse: PermissionHandler = () => ({
  kind: 'reject',
  feedback: 'Healing inference sessions cannot execute tools.',
})

export function buildHealingPrompt(request: HealingInferenceRequest): string {
  return `Assess this failed migration unit and return the required JSON decision.\n${JSON.stringify(request)}`
}

function decisionJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Non-error value was thrown')
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export class CopilotSdkCompletionClient {
  public constructor(
    private readonly clientFactory: CopilotSdkClientFactory = (options) =>
      new CopilotClient(options),
    private readonly timeoutMs = 60_000,
    private readonly lifecycleTimeoutMs = 15_000,
  ) {}

  public async complete(
    request: CopilotCompletionRequest,
  ): Promise<CopilotCompletionResponse> {
    const client = this.clientFactory({
      useLoggedInUser: true,
      workingDirectory: process.cwd(),
      logLevel: 'error',
    })
    let session: CopilotSdkSessionLike | undefined
    let result: string | undefined
    let sdkMessageId: string | undefined
    let operationFailure: Error | undefined

    try {
      await withTimeout(
        client.start(),
        this.lifecycleTimeoutMs,
        'GitHub Copilot startup',
      )
      session = await withTimeout(
        client.createSession({
          clientName: 'ado-to-github-teams',
          availableTools: [],
          enableConfigDiscovery: false,
          onPermissionRequest: rejectToolUse,
          systemMessage: {
            mode: 'append',
            content: HEALING_SYSTEM_MESSAGE,
          },
        }),
        this.lifecycleTimeoutMs,
        'GitHub Copilot session creation',
      )
      const response = await session.sendAndWait(
        {prompt: request.prompt},
        this.timeoutMs,
      )
      if (!response) {
        throw new Error('GitHub Copilot completed without an assistant decision')
      }
      result = response.data.content
      sdkMessageId = response.data.messageId
    } catch (error) {
      operationFailure = toError(error)
    }

    const cleanupFailures: Error[] = []
    if (session) {
      try {
        await withTimeout(
          session.disconnect(),
          this.lifecycleTimeoutMs,
          'GitHub Copilot session disconnect',
        )
      } catch (error) {
        cleanupFailures.push(toError(error))
      }
    }
    try {
      cleanupFailures.push(
        ...(await withTimeout(
          client.stop(),
          this.lifecycleTimeoutMs,
          'GitHub Copilot shutdown',
        )),
      )
    } catch (error) {
      cleanupFailures.push(toError(error))
      try {
        await withTimeout(
          client.forceStop(),
          this.lifecycleTimeoutMs,
          'GitHub Copilot forced shutdown',
        )
      } catch (forceError) {
        cleanupFailures.push(toError(forceError))
      }
    }

    if (operationFailure !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [operationFailure, ...cleanupFailures],
          'GitHub Copilot inference and cleanup failed',
        )
      }
      throw operationFailure
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'GitHub Copilot cleanup failed')
    }
    if (result === undefined) {
      throw new Error('GitHub Copilot inference produced no result')
    }
    // Honestly report whether these identifiers came from the real Copilot SDK session
    // (durable, resumable via the SDK/Copilot CLI) or are only a local correlation ID
    // (never tracked by GitHub, useful solely for correlating this process's own logs).
    const trace: AgentTraceIdentity = session
      ? {
          agentSessionId: session.sessionId,
          sdkProvided: true,
          ...(sdkMessageId ? {agentMessageId: sdkMessageId} : {}),
          localCorrelationId: request.localCorrelationId,
        }
      : {
          agentSessionId: request.localCorrelationId,
          sdkProvided: false,
          localCorrelationId: request.localCorrelationId,
        }
    return {content: result, trace}
  }
}

export function makeCopilotHealingReasonerLayer(
  completion: CopilotCompletion = new CopilotSdkCompletionClient(),
  correlationIdFactory: () => string = () => randomUUID(),
) {
  return Layer.succeed(HealingReasonerTag, {
    assess: (request) => {
      const localCorrelationId = correlationIdFactory()
      const prompt = buildHealingPrompt(request)
      return Effect.tryPromise({
        try: () => completion.complete({prompt, localCorrelationId}),
        catch: (error) =>
          new HealingInferenceFailure({
            service: 'copilot',
            message: `GitHub Copilot healing inference failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            cause: error,
          }),
      }).pipe(
        Effect.flatMap(({content, trace}) =>
          Effect.try({
            try: () => decisionJson(content),
            catch: (error) =>
              new HealingInferenceFailure({
                service: 'copilot',
                message: 'GitHub Copilot healing response was not valid JSON',
                cause: error,
              }),
          }).pipe(Effect.map((decision) => ({content, trace, decision}))),
        ),
        Effect.flatMap(({content, trace, decision}) =>
          decodeHealingInferenceDecision(decision).pipe(
            Effect.map((decoded) => ({content, trace, decoded})),
          ),
        ),
        Effect.map(({content, trace, decoded}) => ({
          ...decoded,
          trace: {
            ...trace,
            conversationHistory: [
              {role: 'system' as const, content: HEALING_SYSTEM_MESSAGE},
              {role: 'user' as const, content: prompt},
              {role: 'assistant' as const, content},
            ],
          },
        })),
      )
    },
  })
}
