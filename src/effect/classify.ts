import {
  AuthenticationFailure,
  ConflictFailure,
  type DomainFailure,
  NotFoundFailure,
  PermissionFailure,
  TransientFailure,
  type ServiceName,
  ValidationFailure,
} from './errors.js'
import {CircuitOpenError} from '../healing/retry.js'

interface ErrorLike extends Error {
  readonly code?: string
  readonly status?: number
  readonly statusCode?: number
  readonly response?: {
    readonly status?: number
    readonly headers?: Record<string, string | string[] | number | undefined>
  }
  readonly headers?: Record<string, string | string[] | number | undefined>
  readonly lastError?: unknown
}

function statusOf(error: ErrorLike): number | undefined {
  return error.status ?? error.statusCode ?? error.response?.status
}

function normalizeError(raw: unknown): ErrorLike {
  const error = raw instanceof Error ? (raw as ErrorLike) : (new Error(String(raw)) as ErrorLike)
  if (error instanceof CircuitOpenError && error.lastError) {
    return normalizeError(error.lastError)
  }

  return error
}

function getHeader(error: ErrorLike, name: string): string | number | undefined {
  const direct = error.headers?.[name] ?? error.headers?.[name.toLowerCase()]
  const response = error.response?.headers?.[name] ?? error.response?.headers?.[name.toLowerCase()]
  const value = direct ?? response
  if (Array.isArray(value)) {
    return value[0]
  }
  return value
}

function parseRetryAfterMs(error: ErrorLike): number | undefined {
  const retryAfter = getHeader(error, 'retry-after')
  if (retryAfter === undefined) {
    return undefined
  }
  if (typeof retryAfter === 'number') {
    return retryAfter * 1000
  }
  const numeric = Number.parseFloat(retryAfter)
  if (Number.isFinite(numeric)) {
    return numeric * 1000
  }
  const parsedDate = Date.parse(retryAfter)
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now())
  }
  return undefined
}

function isTransientByCode(error: ErrorLike): boolean {
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND'].includes(
    error.code ?? '',
  )
}

export function classifyServiceError(service: ServiceName, raw: unknown): DomainFailure {
  const error = normalizeError(raw)
  const status = statusOf(error)
  const message = error.message

  if (status === 401) {
    return new AuthenticationFailure({service, status, message, cause: raw})
  }
  if (status === 403) {
    const sso = String(getHeader(error, 'x-github-sso') ?? '')
    return new PermissionFailure({
      service,
      status,
      ssoRequired: sso.length > 0,
      message,
      cause: raw,
    })
  }
  if (status === 404) {
    return new NotFoundFailure({service, status, message, cause: raw})
  }
  if (status === 409) {
    return new ConflictFailure({service, status, message, cause: raw})
  }
  if (status === 400 || status === 422) {
    return new ValidationFailure({service, status, message, cause: raw})
  }
  if (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    isTransientByCode(error)
  ) {
    const retryAfterMs = parseRetryAfterMs(error)
    return new TransientFailure({
      service,
      message,
      cause: raw,
      ...(status !== undefined ? {status} : {}),
      ...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
    })
  }
  if (error.name === 'PermissionError') {
    return new PermissionFailure({
      service,
      message,
      cause: raw,
      ssoRequired: String(getHeader(error, 'x-github-sso') ?? '').length > 0,
      ...(status !== undefined ? {status} : {}),
    })
  }
  if (error.name === 'NotFoundError') {
    return new NotFoundFailure({
      service,
      message,
      cause: raw,
      ...(status !== undefined ? {status} : {}),
    })
  }
  if (error.name === 'ValidationError' || error.name === 'AmbiguousMatchError') {
    return new ValidationFailure({
      service,
      message,
      cause: raw,
      ...(status !== undefined ? {status} : {}),
    })
  }

  return new ValidationFailure({
    service,
    message,
    cause: raw,
    ...(status !== undefined ? {status} : {}),
  })
}
