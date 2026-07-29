import {Data} from 'effect'
import {FailureMode} from '../types/failures.js'
import type {ApprovalRequest} from '../types/index.js'

export type ServiceName =
  | 'ado'
  | 'github'
  | 'entra'
  | 'auth'
  | 'checkpoint'
  | 'approval'
  | 'copilot'
  | 'report'
  | 'sandbox'
  | 'topology'

export class TransientFailure extends Data.TaggedError('TransientFailure')<{
  readonly service: ServiceName
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
  readonly cause?: unknown
}> {}

export class AuthenticationFailure extends Data.TaggedError('AuthenticationFailure')<{
  readonly service: ServiceName
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class PermissionFailure extends Data.TaggedError('PermissionFailure')<{
  readonly service: ServiceName
  readonly message: string
  readonly status?: number
  readonly ssoRequired: boolean
  readonly cause?: unknown
}> {}

export class NotFoundFailure extends Data.TaggedError('NotFoundFailure')<{
  readonly service: ServiceName
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class ValidationFailure extends Data.TaggedError('ValidationFailure')<{
  readonly service: ServiceName
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class ConflictFailure extends Data.TaggedError('ConflictFailure')<{
  readonly service: ServiceName
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class DecodeFailure extends Data.TaggedError('DecodeFailure')<{
  readonly service: ServiceName
  readonly message: string
  readonly raw?: unknown
}> {}

export class ApprovalRejected extends Data.TaggedError('ApprovalRejected')<{
  readonly action: string
  readonly context: string
}> {}

export class InterruptedFailure extends Data.TaggedError('InterruptedFailure')<{
  readonly message: string
}> {}

export class HealingInferenceFailure extends Data.TaggedError('HealingInferenceFailure')<{
  readonly service: 'copilot'
  readonly message: string
  readonly cause?: unknown
}> {}

export class BlockingElicitationFailure extends Data.TaggedError('BlockingElicitationFailure')<{
  readonly request: ApprovalRequest
}> {}

export type DomainFailure =
  | TransientFailure
  | AuthenticationFailure
  | PermissionFailure
  | NotFoundFailure
  | ValidationFailure
  | ConflictFailure
  | DecodeFailure
  | ApprovalRejected
  | InterruptedFailure
  | HealingInferenceFailure
  | BlockingElicitationFailure

export function toFailureMode(error: DomainFailure): FailureMode {
  switch (error._tag) {
    case 'TransientFailure':
      return FailureMode.RATE_LIMITED
    case 'AuthenticationFailure':
      return FailureMode.TOKEN_EXPIRED
    case 'PermissionFailure':
      return error.ssoRequired ? FailureMode.SSO_ENFORCEMENT : FailureMode.PERMISSION_DENIED
    case 'NotFoundFailure':
      return FailureMode.NOT_FOUND
    case 'ValidationFailure':
      return FailureMode.VALIDATION_ERROR
    case 'ConflictFailure':
      return FailureMode.TEAM_NAME_CONFLICT
    case 'DecodeFailure':
      return FailureMode.VALIDATION_ERROR
    case 'ApprovalRejected':
      return FailureMode.PARTIAL_FAILURE
    case 'InterruptedFailure':
      return FailureMode.PARTIAL_FAILURE
    case 'HealingInferenceFailure':
      return FailureMode.UNKNOWN
    case 'BlockingElicitationFailure':
      return FailureMode.PARTIAL_FAILURE
    default:
      return FailureMode.UNKNOWN
  }
}
