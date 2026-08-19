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

/**
 * Transport-level failure codes that justify a retry.
 *
 * The `UND_ERR_*` entries are undici's codes — undici backs Node's global `fetch`, which the
 * GitHub adapter uses. `UND_ERR_SOCKET` is what a peer reset, a mid-body reset, and a truncated
 * response body all surface as; the timeout codes are undici's analogues of `ETIMEDOUT`.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/**
 * Collects every `code` reachable from an error graph.
 *
 * This must walk the graph rather than read `error.code` directly. Node's `fetch` never exposes a
 * transport code on the error it throws: it throws `TypeError: fetch failed` with `code`
 * `undefined` and puts the real `SocketError`/`ECONNREFUSED` in `cause`. Reading only the top-level
 * code therefore classified every socket reset, refused connection, and truncated body as an
 * unrecognised error, which fell through to `ValidationFailure` — a NON-retryable failure. A
 * transient network blip mid-migration aborted the run permanently instead of being retried.
 *
 * `AggregateError.errors` is traversed too: a dual-stack connection attempt reports per-address
 * failures there. `lastError` covers `CircuitOpenError`. The `seen` set makes a cyclic `cause`
 * chain terminate.
 */
function collectErrorCodes(root: unknown): ReadonlySet<string> {
  const codes = new Set<string>()
  const seen = new Set<unknown>()
  const queue: unknown[] = [root]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      continue
    }
    seen.add(current)

    const candidate = current as {
      readonly code?: unknown
      readonly cause?: unknown
      readonly errors?: unknown
      readonly lastError?: unknown
    }
    if (typeof candidate.code === 'string') {
      codes.add(candidate.code)
    }
    if (candidate.cause !== undefined) {
      queue.push(candidate.cause)
    }
    if (candidate.lastError !== undefined) {
      queue.push(candidate.lastError)
    }
    if (Array.isArray(candidate.errors)) {
      // `Array.isArray` widens `unknown` to `any[]`; re-narrow to `unknown[]` so no `any` leaks
      // into the queue.
      for (const nested of candidate.errors as ReadonlyArray<unknown>) {
        queue.push(nested)
      }
    }
  }

  return codes
}

function isTransientByCode(error: ErrorLike): boolean {
  for (const code of collectErrorCodes(error)) {
    if (TRANSIENT_ERROR_CODES.has(code)) {
      return true
    }
  }
  return false
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
