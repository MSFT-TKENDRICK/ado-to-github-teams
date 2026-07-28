export class CircuitOpenError extends Error {
  public readonly lastError: Error

  public constructor(message: string, lastError: Error) {
    super(message)
    this.name = 'CircuitOpenError'
    this.lastError = lastError
  }
}

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  retryableStatusCodes?: number[]
}

interface HttpErrorLike extends Error {
  code?: string
  status?: number
  response?: {
    status?: number
    headers?: Record<string, string | string[] | number | undefined>
  }
  headers?: Record<string, string | string[] | number | undefined>
}

const DEFAULT_RETRYABLE_STATUS_CODES = [429, 502, 503, 504]
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404])

export function parseRetryAfterMs(
  retryAfter: string | number | undefined,
): number | undefined {
  if (retryAfter === undefined) {
    return undefined
  }

  const normalized = typeof retryAfter === 'number' ? `${retryAfter}` : retryAfter.trim()
  const numericSeconds = Number.parseFloat(normalized)
  if (Number.isFinite(numericSeconds)) {
    return Math.max(0, numericSeconds * 1000)
  }

  const timestamp = Date.parse(normalized)
  if (Number.isNaN(timestamp)) {
    return undefined
  }

  return Math.max(0, timestamp - Date.now())
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

function getStatus(error: HttpErrorLike): number | undefined {
  return error.status ?? error.response?.status
}

function getRetryAfter(error: HttpErrorLike): string | number | undefined {
  const responseHeader =
    error.response?.headers?.['retry-after'] ?? error.response?.headers?.['Retry-After']
  const directHeader = error.headers?.['retry-after'] ?? error.headers?.['Retry-After']
  const value = responseHeader ?? directHeader
  if (Array.isArray(value)) {
    return value[0]
  }
  return value
}

function isNetworkRetryable(error: HttpErrorLike): boolean {
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code ?? '')
}

function isRetryable(
  error: HttpErrorLike,
  retryableStatusCodes: readonly number[],
): boolean {
  const status = getStatus(error)
  if (status !== undefined) {
    if (NON_RETRYABLE_STATUS_CODES.has(status)) {
      return false
    }

    return retryableStatusCodes.includes(status)
  }

  return isNetworkRetryable(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const jitter = Math.floor(Math.random() * 1000)
  const exponential = baseDelayMs * 2 ** (attempt - 1)
  return Math.min(maxDelayMs, exponential + jitter)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  onRetry?: (attempt: number, delayMs: number, error: Error) => void,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 30_000
  const retryableStatusCodes =
    options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES

  let attempt = 1
  while (attempt <= maxAttempts) {
    try {
      return await fn()
    } catch (rawError) {
      const error = toError(rawError) as HttpErrorLike
      const retryable = isRetryable(error, retryableStatusCodes)
      if (!retryable) {
        throw error
      }

      if (attempt >= maxAttempts) {
        throw new CircuitOpenError(
          `Retry circuit opened after ${attempt} attempts`,
          error,
        )
      }

      const retryAfterMs = parseRetryAfterMs(getRetryAfter(error))
      const waitMs =
        retryAfterMs !== undefined
          ? Math.min(maxDelayMs, retryAfterMs)
          : computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs)

      onRetry?.(attempt, waitMs, error)
      await delay(waitMs)
      attempt += 1
    }
  }

  throw new CircuitOpenError('Retry circuit opened unexpectedly', new Error('No attempts executed'))
}
