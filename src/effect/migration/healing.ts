import {Effect, Option} from 'effect'
import {
  NotFoundFailure,
  TransientFailure,
  ValidationFailure,
  toFailureMode,
  type DomainFailure,
} from '../errors.js'
import {
  healingInferenceRequest,
  type HealingInferenceDecision,
} from '../healing.js'
import {HealingReasonerTag} from '../services.js'
import {requestCheckpointedApproval} from './approval.js'
import type {MigrationStateStore} from './state-store.js'

export type HealingResolution = 'retry' | 'skip' | 'abort'

interface HealingOptions {
  readonly operation: string
  readonly target: string
  readonly targetType: 'team' | 'member'
  readonly operationKind: 'read' | 'write'
  readonly idempotent: boolean
  readonly checkpointed: boolean
  readonly retryCount: number
}

function requestedAction(
  decision: HealingInferenceDecision,
  failure: DomainFailure,
  options: HealingOptions,
): HealingResolution {
  if (decision.action === 'abort') {
    return 'abort'
  }
  if (
    decision.action === 'retry' &&
    failure instanceof TransientFailure &&
    options.idempotent &&
    options.checkpointed &&
    options.retryCount === 0
  ) {
    return 'retry'
  }
  return 'skip'
}

function inferenceRequestOptions(options: HealingOptions) {
  return {
    operation: options.operation,
    targetType: options.targetType,
    operationKind: options.operationKind,
    idempotent: options.idempotent,
    checkpointed: options.checkpointed,
    retryCount: options.retryCount,
  } as const
}

function supportsManualFallback(failure: DomainFailure): boolean {
  return (
    failure instanceof NotFoundFailure ||
    (failure instanceof ValidationFailure && failure.status === 422)
  )
}

export function resolveWithHealingInference(
  store: MigrationStateStore,
  failure: DomainFailure,
  options: HealingOptions,
) {
  return Effect.gen(function* () {
    const reasoner = yield* Effect.serviceOption(HealingReasonerTag)
    if (Option.isNone(reasoner)) {
      if (!supportsManualFallback(failure)) {
        return 'abort' as const
      }
      const skip = yield* requestCheckpointedApproval(store, {
        action: `Skip failed ${options.operation} without Copilot inference`,
        context: {target: options.target, failure: failure._tag},
        displayLines: [
          failure.message,
          'GitHub Copilot inference is unavailable; manual review is required.',
        ],
        autoApprovable: false,
        elicitation: {
          kind: 'healing',
          operation: options.operation,
          target: options.target,
          targetType: options.targetType,
          failureMode: failure._tag,
          actionOnApprove: 'skip',
        },
      })
      return skip ? ('skip' as const) : ('abort' as const)
    }

    const assessed = yield* Effect.either(
      reasoner.value.assess(
        healingInferenceRequest(failure, inferenceRequestOptions(options)),
      ),
    )
    if (assessed._tag === 'Left') {
      if (!supportsManualFallback(failure)) {
        return 'abort' as const
      }
      const skip = yield* requestCheckpointedApproval(store, {
        action: `Skip failed ${options.operation} after inference failure`,
        context: {target: options.target, failure: failure._tag},
        displayLines: [failure.message, assessed.left.message],
        autoApprovable: false,
        elicitation: {
          kind: 'healing',
          operation: options.operation,
          target: options.target,
          targetType: options.targetType,
          failureMode: failure._tag,
          actionOnApprove: 'skip',
        },
      })
      return skip ? ('skip' as const) : ('abort' as const)
    }

    const decision = assessed.right
    const action = requestedAction(decision, failure, options)
    if (action === 'abort') {
      return action
    }
    if (
      action === 'retry' &&
      decision.safeToAutomate &&
      decision.confidence >= 0.9
    ) {
      const state = yield* store.get
      yield* store.save({
        ...state,
        failureLog: [
          ...state.failureLog,
          {
            failureMode: toFailureMode(failure),
            failureTag: failure._tag,
            error: failure.message,
            healingAction: `Copilot authorized one bounded retry at confidence ${decision.confidence}`,
            target: options.target,
            automaticRetry: true,
            resolved: false,
          },
        ],
      })
      return action
    }

    const approved = yield* requestCheckpointedApproval(store, {
      action:
        action === 'retry'
          ? `Retry failed ${options.operation} per Copilot recommendation`
          : decision.action === 'retry'
          ? `Skip failed ${options.operation}; the recommended retry is not permitted`
          : decision.action === 'escalate'
          ? `Skip failed ${options.operation} after operator review`
          : `Skip failed ${options.operation} per Copilot recommendation`,
      context: {
        target: options.target,
        recommendation: decision.action,
        confidence: decision.confidence,
      },
      displayLines: [
        decision.rationale,
        `Risk: ${decision.risk}`,
        ...(decision.action === 'retry' && action === 'skip'
          ? [
              'Local safety policy rejected the retry; approval only skips this unit.',
            ]
          : []),
        ...decision.prerequisites.map((item) => `Prerequisite: ${item}`),
      ],
      autoApprovable: false,
      elicitation: {
        kind: 'healing',
        operation: options.operation,
        target: options.target,
        targetType: options.targetType,
        failureMode: failure._tag,
        actionOnApprove: action,
        ...(decision.trace ? {trace: decision.trace} : {}),
      },
    })
    return approved ? action : ('abort' as const)
  })
}
