import path from 'node:path'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {PactV4 as PactV4Class} from '@pact-foundation/pact'
import {
  decodeHealingInferenceDecision,
  type HealingInferenceDecision,
  type HealingInferenceRequest,
} from '../../src/effect/healing.js'
import {HealingReasonerTag} from '../../src/effect/services.js'
import {
  buildHealingPrompt,
  makeCopilotHealingReasonerLayer,
  type CopilotCompletionRequest,
  type CopilotCompletionResponse,
} from '../../src/services/copilot.js'

type PactV4Type = typeof PactV4Class

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe.sequential : describe.skip

async function copilotProvider(): Promise<InstanceType<PactV4Type>> {
  const {PactV4} = await import('@pact-foundation/pact')
  return new PactV4({
    consumer: 'ado-to-github-teams',
    provider: 'github-copilot-sdk',
    dir: path.resolve('test/contract/pacts'),
  })
}

contractDescribe('GitHub Copilot healing inference contract', () => {
  it('contracts the typed failure assessment request and decision response', async () => {
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
    const response: HealingInferenceDecision = {
      action: 'retry',
      confidence: 0.97,
      safeToAutomate: true,
      rationale: 'The operation is idempotent and checkpointed.',
      risk: 'The first request may already have completed.',
      prerequisites: ['Verify current membership before retrying.'],
    }
    const prompt = buildHealingPrompt(request)
    const trace = {
      agentSessionId: 'sdk-session-contract',
      sdkProvided: true,
      agentMessageId: 'sdk-message-contract',
      localCorrelationId: 'local-correlation-contract',
    }
    const completionRequest: CopilotCompletionRequest = {
      prompt,
      localCorrelationId: trace.localCorrelationId,
    }
    const completionResponse: CopilotCompletionResponse = {
      content: JSON.stringify(response),
      trace,
    }
    expect(prompt).not.toContain('platform:ada')
    expect(prompt).not.toContain('Request timed out')
    const provider = await copilotProvider()
    const interaction = provider
      .addSynchronousInteraction('assess a failed resumable migration unit')
      .withRequest((builder) => builder.withJSONContent(completionRequest))
      .withResponse((builder) =>
        builder.withJSONContent(completionResponse),
      )

    await interaction.executeTest(async (message) => {
      const layer = makeCopilotHealingReasonerLayer(
        {
          complete: async (receivedRequest) => {
            expect(receivedRequest).toEqual(message.Request)
            expect(message.Response[0]).toEqual(completionResponse)
            return completionResponse
          },
        },
        () => trace.localCorrelationId,
      )
      const decoded = await Effect.runPromise(
        Effect.gen(function* () {
          const reasoner = yield* HealingReasonerTag
          return yield* reasoner.assess(request)
        }).pipe(Effect.provide(layer)),
      )
      // The reasoner layer always attaches trace/conversationHistory to the decision, so
      // the raw Pact-decoded decision (which never includes a trace) is a subset match.
      expect(decoded).toMatchObject(response)
      expect(decoded.trace).toMatchObject(trace)
      await expect(
        Effect.runPromise(decodeHealingInferenceDecision(response)),
      ).resolves.toEqual(response)
    })
  })
})
