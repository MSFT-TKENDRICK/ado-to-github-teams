import type {ApprovalManager} from '../checkpoints/approval.js'
import {FailureMode, type HealingAction, type HealingResult} from '../types/failures.js'
import {ConflictResolver} from './conflict-resolver.js'
import {TokenRefresher} from './token-refresher.js'

interface ErrorLike extends Error {
  code?: string
  status?: number
  response?: {
    status?: number
    headers?: Record<string, string | undefined>
  }
  headers?: Record<string, string | undefined>
}

export interface DispatchRequest {
  error: Error
  mode?: FailureMode
  context: Record<string, unknown>
  approval?: ApprovalManager
  tokenRefresher?: TokenRefresher
  tokenService?: 'ado' | 'github' | 'entra'
  retryFn?: () => Promise<unknown>
  conflictResolver?: ConflictResolver
  conflictInput?: {
    adoName: string
    existingSlug: string
  }
}

function statusOf(error: ErrorLike): number | undefined {
  return error.status ?? error.response?.status
}

function hasSsoHeader(error: ErrorLike): boolean {
  const ssoHeader = error.response?.headers?.['x-github-sso'] ?? error.headers?.['x-github-sso']
  return typeof ssoHeader === 'string' && ssoHeader.length > 0
}

function isNetworkError(error: ErrorLike): boolean {
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(error.code ?? '')
}

export class HealingDispatcher {
  public detectFailureMode(error: Error): FailureMode {
    const typed = error as ErrorLike
    const status = statusOf(typed)
    const message = error.message.toLowerCase()
    if (message.includes('partial failure')) {
      return FailureMode.PARTIAL_FAILURE
    }
    if (message.includes('circular group')) {
      return FailureMode.CIRCULAR_GROUP
    }
    if (message.includes('suspended')) {
      return FailureMode.USER_SUSPENDED
    }
    if (status === 401) {
      return FailureMode.TOKEN_EXPIRED
    }
    if (status === 429) {
      return FailureMode.RATE_LIMITED
    }
    if (status === 403 && hasSsoHeader(typed)) {
      return FailureMode.SSO_ENFORCEMENT
    }
    if (status === 403) {
      return FailureMode.PERMISSION_DENIED
    }
    if (status === 404) {
      return FailureMode.NOT_FOUND
    }
    if (status === 422 || status === 400) {
      return FailureMode.VALIDATION_ERROR
    }
    if (status === 409) {
      return FailureMode.TEAM_NAME_CONFLICT
    }
    if (isNetworkError(typed)) {
      return FailureMode.NETWORK_ERROR
    }
    return FailureMode.UNKNOWN
  }

  public async dispatch(request: DispatchRequest): Promise<HealingResult> {
    const mode = request.mode ?? this.detectFailureMode(request.error)
    const action = this.actionFor(mode)

    if (
      mode === FailureMode.TOKEN_EXPIRED &&
      request.retryFn &&
      request.tokenRefresher &&
      request.tokenService
    ) {
      await request.tokenRefresher.handleTokenExpiry(request.tokenService, request.retryFn)
      return {healed: true, action, retryRequest: false}
    }
    if (mode === FailureMode.TOKEN_EXPIRED) {
      return {healed: true, action, retryRequest: true}
    }

    if (
      mode === FailureMode.TEAM_NAME_CONFLICT &&
      request.conflictResolver &&
      request.approval &&
      request.conflictInput
    ) {
      const resolution = await request.conflictResolver.resolveTeamNameConflict(
        request.conflictInput.adoName,
        request.conflictInput.existingSlug,
        request.approval,
      )
      return {
        healed: resolution.approved,
        action,
        userApproved: resolution.approved,
      }
    }

    if (mode === FailureMode.SSO_ENFORCEMENT && request.approval) {
      const approved = await request.approval.requestApproval({
        action: 'Continue after GitHub SSO enforcement error',
        context: request.context,
        displayLines: [
          'GitHub SSO enforcement blocked this action.',
          'Approve to continue by skipping the current item.',
        ],
        autoApprovable: false,
      })
      return {
        healed: approved,
        action,
        userApproved: approved,
        skipItem: approved,
        abortMigration: !approved,
      }
    }

    if (mode === FailureMode.RATE_LIMITED || mode === FailureMode.NETWORK_ERROR) {
      return {
        healed: true,
        action,
        retryRequest: true,
      }
    }

    if (
      mode === FailureMode.NOT_FOUND ||
      mode === FailureMode.VALIDATION_ERROR ||
      mode === FailureMode.USER_SUSPENDED ||
      mode === FailureMode.CIRCULAR_GROUP ||
      mode === FailureMode.PARTIAL_FAILURE
    ) {
      return {
        healed: true,
        action,
        skipItem: true,
      }
    }

    if (mode === FailureMode.PERMISSION_DENIED || mode === FailureMode.UNKNOWN) {
      return {
        healed: false,
        action,
        abortMigration: true,
      }
    }

    return {
      healed: false,
      action,
      abortMigration: true,
    }
  }

  private actionFor(mode: FailureMode): HealingAction {
    switch (mode) {
      case FailureMode.RATE_LIMITED:
        return {
          mode,
          description: 'Retry with backoff after rate limit',
          requiresUserApproval: false,
          autoExecute: true,
        }
      case FailureMode.TOKEN_EXPIRED:
        return {
          mode,
          description: 'Refresh token and retry once',
          requiresUserApproval: false,
          autoExecute: true,
        }
      case FailureMode.TEAM_NAME_CONFLICT:
        return {
          mode,
          description: 'Resolve slug conflict with operator approval',
          requiresUserApproval: true,
          autoExecute: false,
        }
      case FailureMode.PARTIAL_FAILURE:
        return {
          mode,
          description: 'Skip failed item and continue',
          requiresUserApproval: true,
          autoExecute: false,
        }
      case FailureMode.USER_SUSPENDED:
        return {
          mode,
          description: 'Skip suspended user',
          requiresUserApproval: false,
          autoExecute: true,
        }
      case FailureMode.CIRCULAR_GROUP:
        return {
          mode,
          description: 'Skip circular Entra group branch',
          requiresUserApproval: false,
          autoExecute: true,
        }
      case FailureMode.SSO_ENFORCEMENT:
        return {
          mode,
          description: 'Require explicit approval to continue after SSO enforcement',
          requiresUserApproval: true,
          autoExecute: false,
        }
      case FailureMode.NETWORK_ERROR:
        return {
          mode,
          description: 'Retry request for transient network issue',
          requiresUserApproval: false,
          autoExecute: true,
        }
      case FailureMode.PERMISSION_DENIED:
        return {
          mode,
          description: 'Abort migration due to missing permissions',
          requiresUserApproval: false,
          autoExecute: false,
        }
      case FailureMode.NOT_FOUND:
        return {
          mode,
          description: 'Skip missing item and continue',
          requiresUserApproval: false,
          autoExecute: true,
        }
      case FailureMode.VALIDATION_ERROR:
        return {
          mode,
          description: 'Skip invalid item and continue',
          requiresUserApproval: false,
          autoExecute: true,
        }
      case FailureMode.UNKNOWN:
      default:
        return {
          mode: FailureMode.UNKNOWN,
          description: 'Abort on unknown failure mode',
          requiresUserApproval: false,
          autoExecute: false,
        }
    }
  }
}
