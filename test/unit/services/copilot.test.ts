import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import type {CopilotClientOptions} from '@github/copilot-sdk'
import type {HealingInferenceRequest} from '../../../src/effect/healing.js'
import {HealingReasonerTag} from '../../../src/effect/services.js'
import {
  buildHealingPrompt,
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

describe('buildHealingPrompt', () => {
  it('serializes the typed failure request into the prompt body', () => {
    const prompt = buildHealingPrompt(request)
    expect(prompt).toContain('Assess this failed migration unit')
    expect(JSON.parse(prompt.split('\n')[1] ?? '')).toEqual(request)
  })
})

describe('CopilotSdkCompletionClient', () => {
  it('uses ambient authentication and disables tools for inference', async () => {
    const disconnect = vi.fn(async () => undefined)
    const session: CopilotSdkSessionLike = {
      sendAndWait: vi.fn(async () => ({
        data: {content: '{"action":"abort"}'},
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
    const factory = vi.fn((_options: CopilotClientOptions) => client)
    const trace = {
      agentSessionId: 'agent-session',
      agentThreadId: 'agent-thread',
      inferenceTraceId: 'inference-trace',
    }

    const completion = new CopilotSdkCompletionClient(factory, 5000)
    await expect(completion.complete({prompt: 'classify', trace})).resolves.toEqual({
      content: '{"action":"abort"}',
      trace,
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
})

describe('Copilot healing reasoner layer', () => {
  it('decodes a fenced JSON decision from the SDK response', async () => {
    const layer = makeCopilotHealingReasonerLayer({
      complete: vi.fn(async (completionRequest) => ({
        content: `\`\`\`json
{"action":"retry","confidence":0.97,"safeToAutomate":true,"rationale":"Idempotent PUT","risk":"Duplicate request","prerequisites":["Checkpoint exists"]}
\`\`\``,
        trace: completionRequest.trace,
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
        agentSessionId: expect.any(String),
        agentThreadId: expect.any(String),
        inferenceTraceId: expect.any(String),
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
        trace: completionRequest.trace,
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
