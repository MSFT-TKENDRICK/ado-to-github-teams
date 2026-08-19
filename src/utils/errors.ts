export class HttpStatusError extends Error {
  public readonly status: number
  public readonly headers: Record<string, string | undefined>
  public readonly responseBody?: unknown

  public constructor(
    message: string,
    status: number,
    headers: Record<string, string | undefined> = {},
    responseBody?: unknown,
  ) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
    this.headers = headers
    this.responseBody = responseBody
  }
}

export class PermissionError extends Error {
  public readonly status?: number
  public readonly headers?: Record<string, string | undefined>

  public constructor(
    message: string,
    status?: number,
    headers?: Record<string, string | undefined>,
  ) {
    super(message)
    this.name = 'PermissionError'
    if (status !== undefined) {
      this.status = status
    }
    if (headers !== undefined) {
      this.headers = headers
    }
  }
}

export class ValidationError extends Error {
  public readonly status?: number

  public constructor(message: string, status?: number) {
    super(message)
    this.name = 'ValidationError'
    if (status !== undefined) {
      this.status = status
    }
  }
}

export class NotFoundError extends Error {
  public readonly status?: number

  public constructor(message: string, status?: number) {
    super(message)
    this.name = 'NotFoundError'
    if (status !== undefined) {
      this.status = status
    }
  }
}

export class AmbiguousMatchError extends Error {
  public readonly candidates: string[]

  public constructor(message: string, candidates: string[]) {
    super(message)
    this.name = 'AmbiguousMatchError'
    this.candidates = candidates
  }
}

/**
 * Transport-level failure codes that justify a retry rather than an abort.
 *
 * The `UND_ERR_*` entries are undici's codes — undici backs Node's global `fetch`, which the
 * service adapters use. `UND_ERR_SOCKET` is what a peer reset, a mid-body reset, and a truncated
 * response body all surface as; the timeout codes are undici's analogues of `ETIMEDOUT`.
 */
export const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
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
 * `undefined` and puts the real `SocketError`/`ECONNREFUSED` in `cause`. Reading only the
 * top-level code classified every socket reset, refused connection, and truncated body as an
 * unrecognised error — which meant a transient network blip mid-migration was treated as
 * permanent instead of being retried.
 *
 * `AggregateError.errors` is traversed too: a dual-stack connection attempt reports per-address
 * failures there. `lastError` covers `CircuitOpenError`. The `seen` set makes a cyclic `cause`
 * chain terminate.
 *
 * Shared by `classifyServiceError` and the healing dispatcher so the two can never disagree about
 * what counts as a transient transport failure.
 */
export function collectErrorCodes(root: unknown): ReadonlySet<string> {
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

/** True when any error in the graph carries a retryable transport code. */
export function hasTransientTransportCode(error: unknown): boolean {
  for (const code of collectErrorCodes(error)) {
    if (TRANSIENT_ERROR_CODES.has(code)) {
      return true
    }
  }
  return false
}
