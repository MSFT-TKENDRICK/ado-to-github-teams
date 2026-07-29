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
    const factory = vi.fn(() => client)

    const completion = new CopilotSdkCompletionClient(factory, 5000)
    await expect(completion.complete({prompt: 'classify'})).resolves.toEqual({
      content: '{"action":"abort"}',
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
      complete: vi.fn(async () => ({
        content: `\`\`\`json
{"action":"retry","confidence":0.97,"safeToAutomate":true,"rationale":"Idempotent PUT","risk":"Duplicate request","prerequisites":["Checkpoint exists"]}
\`\`\``,
      })),
    })

    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const reasoner = yield* HealingReasonerTag
        return yield* reasoner.assess(request)
      }).pipe(Effect.provide(layer)),
    )

    expect(decision).toEqual({
      action: 'retry',
      confidence: 0.97,
      safeToAutomate: true,
      rationale: 'Idempotent PUT',
      risk: 'Duplicate request',
      prerequisites: ['Checkpoint exists'],
    })
  })

  it('rejects malformed model output as a typed inference failure', async () => {
    const layer = makeCopilotHealingReasonerLayer({
      complete: vi.fn(async () => ({content: '{"action":"retry"}'})),
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
