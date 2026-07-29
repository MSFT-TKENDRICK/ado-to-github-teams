import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {ValidationFailure} from '../../../../src/effect/errors.js'
import {resolveWithHealingInference} from '../../../../src/effect/migration/healing.js'
import {HealingReasonerTag} from '../../../../src/effect/services.js'
import {mappingLayer} from './test-layers.js'
import {checkpointState, memoryStateStore} from './test-state.js'

describe('parallel healing trace capture', () => {
  it('persists redacted agent conversation and trace identifiers around escalation', async () => {
    const memory = memoryStateStore(checkpointState())
    const layers = Layer.merge(
      mappingLayer({
        approval: {request: () => Effect.succeed(true)},
      }),
      Layer.succeed(HealingReasonerTag, {
        assess: () =>
          Effect.succeed({
            action: 'escalate',
            confidence: 0.75,
            safeToAutomate: false,
            rationale: 'Operator review required for user@example.com',
            risk: 'token=do-not-store',
            prerequisites: ['Confirm target policy'],
          }),
      }),
    )

    const resolution = await Effect.runPromise(
      resolveWithHealingInference(
        memory.store,
        new ValidationFailure({
          service: 'github',
          message: 'Invalid member',
          status: 422,
        }),
        {
          operation: 'assign-member',
          target: 'platform:user@example.com',
          targetType: 'member',
          operationKind: 'write',
          idempotent: true,
          checkpointed: true,
          retryCount: 0,
        },
      ).pipe(Effect.provide(layers)),
    )

    expect(resolution).toBe('skip')
    expect(memory.state().agentConversationHistory).toHaveLength(2)
    expect(memory.state().traceLogs).toHaveLength(2)
    const persisted = JSON.stringify(memory.state().agentConversationHistory)
    expect(persisted).not.toContain('user@example.com')
    expect(persisted).not.toContain('do-not-store')
    expect(memory.state().agentConversationHistory?.[0]?.agentSessionId).toMatch(
      /^agent-/,
    )
    expect(memory.state().agentConversationHistory?.[0]?.threadId).toMatch(
      /^thread-/,
    )
  })
})
