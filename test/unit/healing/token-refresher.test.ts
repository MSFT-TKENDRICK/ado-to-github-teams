import {describe, expect, it, vi} from 'vitest'
import {TokenRefresher} from '../../../src/healing/token-refresher.js'

interface AuthError extends Error {
  status?: number
}

function unauthorizedError(): AuthError {
  const error = new Error('unauthorized') as AuthError
  error.status = 401
  return error
}

describe('TokenRefresher', () => {
  it('refreshes token on 401 and retries successfully', async () => {
    const reauth = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const refresher = new TokenRefresher(async () => reauth())

    const retryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unauthorizedError())
      .mockResolvedValue('ok')

    const result = await refresher.handleTokenExpiry('github', retryFn)
    expect(result).toBe('ok')
    expect(reauth).toHaveBeenCalledTimes(1)
    expect(retryFn).toHaveBeenCalledTimes(2)
  })

  it('does not refresh for non-401 errors', async () => {
    const reauth = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const refresher = new TokenRefresher(async () => reauth())
    const retryFn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('boom'))
    await expect(refresher.handleTokenExpiry('ado', retryFn)).rejects.toThrow('boom')
    expect(reauth).not.toHaveBeenCalled()
  })

  it('throws if re-authentication fails', async () => {
    const refresher = new TokenRefresher(async () => {
      throw new Error('reauth failed')
    })
    const retryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unauthorizedError())
      .mockResolvedValue('ok')
    await expect(refresher.handleTokenExpiry('entra', retryFn)).rejects.toThrow('reauth failed')
  })
})
