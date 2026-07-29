import {Effect, Either, Schema} from 'effect'
import type {AgentTraceContext} from '../types/index.js'
import type {DomainFailure} from './errors.js'
import {HealingInferenceFailure} from './errors.js'

export const healingRecommendations = ['retry', 'skip', 'abort', 'escalate'] as const

export interface HealingInferenceRequest {
  readonly operation: string
  readonly targetType: 'team' | 'member'
  readonly operationKind: 'read' | 'write'
  readonly idempotent: boolean
  readonly checkpointed: boolean
  readonly retryCount: number
  readonly failure: {
    readonly tag: DomainFailure['_tag']
    readonly service: string
    readonly status?: number
  }
}

export interface HealingInferenceDecision {
  readonly action: (typeof healingRecommendations)[number]
  readonly confidence: number
  readonly safeToAutomate: boolean
  readonly rationale: string
  readonly risk: string
  readonly prerequisites: readonly string[]
  readonly trace?: AgentTraceContext
}

export const HealingInferenceDecisionSchema = Schema.Struct({
  action: Schema.Literal(...healingRecommendations),
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
  safeToAutomate: Schema.Boolean,
  rationale: Schema.String,
  risk: Schema.String,
  prerequisites: Schema.Array(Schema.String),
})

export function decodeHealingInferenceDecision(
  input: unknown,
): Effect.Effect<HealingInferenceDecision, HealingInferenceFailure> {
  const decoded = Schema.decodeUnknownEither(HealingInferenceDecisionSchema, {
    onExcessProperty: 'error',
  })(input)
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new HealingInferenceFailure({
        service: 'copilot',
        message: 'GitHub Copilot returned a malformed healing decision',
        cause: decoded.left,
      }),
    )
  }
  return Effect.succeed(decoded.right)
}

export function healingInferenceRequest(
  failure: DomainFailure,
  options: Omit<HealingInferenceRequest, 'failure'>,
): HealingInferenceRequest {
  const status = 'status' in failure ? failure.status : undefined
  return {
    ...options,
    failure: {
      tag: failure._tag,
      service: 'service' in failure ? failure.service : 'migration',
      ...(status === undefined ? {} : {status}),
    },
  }
}
