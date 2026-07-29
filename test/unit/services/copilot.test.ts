import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import type {HealingInferenceRequest} from '../../../src/effect/healing.js'
import {HealingReasonerTag} from '../../../src/effect/services.js'
import {
  CopilotSdkCompletionClient,
  makeCopilotHealingReasonerLayer,
  type CopilotSdkClientLike,
  type CopilotSdkSessionLike,
} from '../../../src/services/copilot.js'

const request: HealingInferenceRequest = {
  operation: 'assign-member',
  targetType: 'member',
  operationKind: 'write',
  idempotent: true,
  checkpointed: true,
  retryCount: 0,
  failure: {
    tag: 'TransientFailure',
    service: 'github',
    status: 503,
  },
}

describe('CopilotSdkCompletionClient', () => {
  it('captures real SDK session/message IDs and marks the trace as SDK-provided', async () => {
    const disconnect = vi.fn(async () => undefined)
    const session: CopilotSdkSessionLike = {
      sessionId: 'sdk-session-42',
      sendAndWait: vi.fn(async () => ({
        id: 'sdk-response-1',
        data: {content: '{"action":"abort"}', messageId: 'sdk-message-7'},
      })),
      disconnect,
    }
    const stop = vi.fn(async () => [])
    const forceStop = vi.fn(async () => undefined)
    const createSession = vi.fn(async () => session)
    const client: CopilotSdkClientLike = {
      start: vi.fn(async () => undefined),
      createSession,
      stop,
      forceStop,
    }
    const factory = vi.fn(() => client)

    const completion = new CopilotSdkCompletionClient(factory, 5000)
    await expect(
      completion.complete({
        prompt: 'classify',
        localCorrelationId: 'local-correlation-1',
      }),
    ).resolves.toEqual({
      content: '{"action":"abort"}',
      trace: {
        agentSessionId: 'sdk-session-42',
        sdkProvided: true,
        agentMessageId: 'sdk-message-7',
        localCorrelationId: 'local-correlation-1',
      },
    })

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        useLoggedInUser: true,
        workingDirectory: process.cwd(),
      }),
    )
    expect(factory.mock.calls[0]?.[0].gitHubToken).toBeUndefined()
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        availableTools: [],
        enableConfigDiscovery: false,
        onPermissionRequest: expect.any(Function),
      }),
    )
    expect(disconnect).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('propagates a descriptive error when the SDK client fails before a session exists', async () => {
    const factory = vi.fn(() => {
      throw new Error('SDK unavailable')
    })

    const completion = new CopilotSdkCompletionClient(factory, 5000)
    await expect(
      completion.complete({
        prompt: 'classify',
        localCorrelationId: 'local-correlation-2',
      }),
    ).rejects.toThrow('SDK unavailable')
  })
})

describe('Copilot healing reasoner layer', () => {
  it('decodes a fenced JSON decision from the SDK response', async () => {
    const layer = makeCopilotHealingReasonerLayer({
      complete: vi.fn(async () => ({
        content: `\`\`\`json
{"action":"retry","confidence":0.97,"safeToAutomate":true,"rationale":"Idempotent PUT","risk":"Duplicate request","prerequisites":["Checkpoint exists"]}
\`\`\``,
        trace: {
          agentSessionId: 'sdk-session-9',
          sdkProvided: true,
          agentMessageId: 'sdk-message-9',
          localCorrelationId: 'local-correlation-3',
        },
      })),
    })

    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const reasoner = yield* HealingReasonerTag
        return yield* reasoner.assess(request)
      }).pipe(Effect.provide(layer)),
    )

    expect(decision).toMatchObject({
      action: 'retry',
      confidence: 0.97,
      safeToAutomate: true,
      rationale: 'Idempotent PUT',
      risk: 'Duplicate request',
      prerequisites: ['Checkpoint exists'],
      trace: {
        agentSessionId: 'sdk-session-9',
        sdkProvided: true,
        agentMessageId: 'sdk-message-9',
        localCorrelationId: 'local-correlation-3',
        conversationHistory: [
          {role: 'system', content: expect.any(String)},
          {role: 'user', content: expect.stringContaining('assign-member')},
          {role: 'assistant', content: expect.stringContaining('"action":"retry"')},
        ],
      },
    })
  })

  it('rejects malformed model output as a typed inference failure', async () => {
    const layer = makeCopilotHealingReasonerLayer({
      complete: vi.fn(async (completionRequest) => ({
        content: '{"action":"retry"}',
        trace: {
          agentSessionId: completionRequest.localCorrelationId,
          sdkProvided: false,
          localCorrelationId: completionRequest.localCorrelationId,
        },
      })),
    })

    const program = Effect.gen(function* () {
      const reasoner = yield* HealingReasonerTag
      return yield* reasoner.assess(request)
    }).pipe(Effect.provide(layer), Effect.either)

    await expect(Effect.runPromise(program)).resolves.toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'HealingInferenceFailure',
        service: 'copilot',
      },
    })
  })
})
