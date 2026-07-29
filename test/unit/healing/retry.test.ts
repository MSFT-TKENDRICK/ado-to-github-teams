import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {CircuitOpenError, parseRetryAfterMs, withRetry} from '../../../src/healing/retry.js'

interface RetryError extends Error {
  status?: number
  code?: string
  response?: {
    status?: number
    headers?: Record<string, string | string[]>
  }
}

function makeStatusError(status: number, retryAfter?: string): RetryError {
  const error = new Error(`HTTP ${status}`) as RetryError
  error.status = status
  error.response = {
    status,
    headers: retryAfter ? {'retry-after': retryAfter} : {},
  }
  return error
}

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses exponential backoff and resolves', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(makeStatusError(503))
      .mockRejectedValueOnce(makeStatusError(503))
      .mockResolvedValue('ok')
    const retries: number[] = []

    const promise = withRetry(
      fn,
      {baseDelayMs: 100, maxDelayMs: 5000, maxAttempts: 5},
      (_attempt, delayMs) => {
        retries.push(delayMs)
      },
    )

    await vi.advanceTimersByTimeAsync(300)
    await expect(promise).resolves.toBe('ok')
    expect(retries).toEqual([100, 200])
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('honors Retry-After numeric header', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(makeStatusError(429, '3'))
      .mockResolvedValue('done')

    const retries: number[] = []
    const promise = withRetry(fn, {baseDelayMs: 100, maxAttempts: 2}, (_attempt, delayMs) =>
      retries.push(delayMs),
    )

    await vi.advanceTimersByTimeAsync(3000)
    await expect(promise).resolves.toBe('done')
    expect(retries).toEqual([3000])
  })

  it('honors Retry-After date header', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const retryAt = new Date(Date.now() + 5000).toUTCString()
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(makeStatusError(429, retryAt))
      .mockResolvedValue('done')

    const retries: number[] = []
    const promise = withRetry(fn, {maxAttempts: 2}, (_attempt, delayMs) => retries.push(delayMs))
    await vi.advanceTimersByTimeAsync(5000)
    await expect(promise).resolves.toBe('done')
    expect(retries[0]).toBeGreaterThanOrEqual(4000)
    expect(retries[0]).toBeLessThanOrEqual(5000)
  })

  it('throws CircuitOpenError at max attempts', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(makeStatusError(503))
    const promise = withRetry(fn, {maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1})
    const rejection = expect(promise).rejects.toBeInstanceOf(CircuitOpenError)
    await vi.advanceTimersByTimeAsync(10)
    await rejection
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws non-retryable errors immediately', async () => {
    const error = makeStatusError(400)
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(error)
    await expect(withRetry(fn)).rejects.toBe(error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries network errors by code', async () => {
    const networkError = new Error('socket reset') as RetryError
    networkError.code = 'ECONNRESET'
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValue('ok')
    const promise = withRetry(fn, {baseDelayMs: 50, maxAttempts: 2})
    await vi.advanceTimersByTimeAsync(50)
    await expect(promise).resolves.toBe('ok')
  })
})

describe('parseRetryAfterMs', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
  })

  it('returns undefined for invalid values', () => {
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined()
  })
})
