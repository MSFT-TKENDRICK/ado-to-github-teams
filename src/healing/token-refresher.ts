import {AuthManager} from '../auth/manager.js'

interface StatusErrorLike extends Error {
  status?: number
  response?: {
    status?: number
  }
}

function isUnauthorized(error: unknown): boolean {
  const statusError = error as StatusErrorLike
  const status = statusError.status ?? statusError.response?.status
  return status === 401
}

export class TokenRefresher {
  public constructor(
    private readonly reauth: (service: 'ado' | 'github' | 'entra') => Promise<void> = async (
      service,
    ) => {
      const authManager = new AuthManager()
      await authManager.refreshCredential(service)
    },
  ) {}

  public async handleTokenExpiry(
    service: 'ado' | 'github' | 'entra',
    retryFn: () => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await retryFn()
    } catch (error) {
      if (!isUnauthorized(error)) {
        throw error
      }
    }

    await this.reauth(service)
    return retryFn()
  }
}
