export enum FailureMode {
  RATE_LIMITED = 'RATE_LIMITED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TEAM_NAME_CONFLICT = 'TEAM_NAME_CONFLICT',
  PARTIAL_FAILURE = 'PARTIAL_FAILURE',
  USER_SUSPENDED = 'USER_SUSPENDED',
  CIRCULAR_GROUP = 'CIRCULAR_GROUP',
  SSO_ENFORCEMENT = 'SSO_ENFORCEMENT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNKNOWN = 'UNKNOWN',
}

export interface HealingAction {
  mode: FailureMode
  description: string
  requiresUserApproval: boolean
  autoExecute: boolean
}

export interface HealingContext {
  error: Error
  mode: FailureMode
  retryCount: number
  context: Record<string, unknown>
}

export interface HealingResult {
  healed: boolean
  action: HealingAction
  userApproved?: boolean
  retryRequest?: boolean
  skipItem?: boolean
  abortMigration?: boolean
}
