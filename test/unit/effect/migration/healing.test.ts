import {Effect, Layer, Ref} from 'effect'
import {describe, expect, it} from 'vitest'
import {makeWorkflowApprovalLayer} from '../../../../src/effect/layers.js'
import {resolveWithHealingInference} from '../../../../src/effect/migration/healing.js'
import {HealingReasonerTag} from '../../../../src/effect/services.js'
import {ValidationFailure} from '../../../../src/effect/errors.js'
import {createInitialState} from '../../../../src/effect/migration/state.js'

describe('durable healing elicitations', () => {
  it('turns a Copilot escalation into a typed workflow blocker with trace context', async () => {
    const initial = createInitialState(
      {
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: true,
        concurrency: 4,
      },
      'run-1',
      '2026-07-29T12:00:00.000Z',
    )
    const stateRef = await Effect.runPromise(Ref.make(initial))
    const store = {
      get: Ref.get(stateRef),
      save: (state: typeof initial) => Ref.set(stateRef, state),
    }
    const trace = {
      agentSessionId: 'sdk-session-healing',
      sdkProvided: true,
      agentMessageId: 'sdk-message-healing',
      localCorrelationId: 'local-correlation-healing',
      conversationHistory: [
        {role: 'user' as const, content: 'Assess failure'},
        {role: 'assistant' as const, content: 'Escalate'},
      ],
    }
    const program = resolveWithHealingInference(
      store,
      new ValidationFailure({
        service: 'github',
        status: 422,
        message: 'Provider rejected membership',
      }),
      {
        operation: 'assign-member',
        target: 'core:ada',
        targetType: 'member',
        operationKind: 'write',
        idempotent: true,
        checkpointed: true,
        retryCount: 0,
      },
    ).pipe(Effect.either)
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.merge(
            makeWorkflowApprovalLayer(true, [
              {
                action: 'Apply migration',
                context: '{}',
                approved: true,
                timestamp: '2026-07-29T12:00:00.000Z',
              },
            ]),
            Layer.succeed(HealingReasonerTag, {
              assess: () =>
                Effect.succeed({
                  action: 'escalate',
                  confidence: 0.75,
                  safeToAutomate: false,
                  rationale: 'Operator context is required.',
                  risk: 'Incorrect identity assignment.',
                  prerequisites: ['Validate source identity.'],
                  trace,
                }),
            }),
          ),
        ),
      ),
    )

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'BlockingElicitationFailure',
        request: {
          elicitation: {
            operation: 'assign-member',
            target: 'core:ada',
            actionOnApprove: 'skip',
            trace,
          },
        },
      },
    })
  })
})
