import {describe, expect, it} from 'vitest'
import {classifyServiceError} from '../../../src/effect/classify.js'

describe('classifyServiceError', () => {
  it('classifies transient rate limit errors with retry-after', () => {
    const error = Object.assign(new Error('rate limit'), {
      status: 429,
      response: {status: 429, headers: {'retry-after': '5'}},
    })
    const classified = classifyServiceError('github', error)
    expect(classified._tag).toBe('TransientFailure')
    if (classified._tag === 'TransientFailure') {
      expect(classified.retryAfterMs).toBe(5000)
    }
  })

  it('classifies sso-enforced permission errors', () => {
    const error = Object.assign(new Error('forbidden'), {
      status: 403,
      response: {status: 403, headers: {'x-github-sso': 'required'}},
    })
    const classified = classifyServiceError('github', error)
    expect(classified._tag).toBe('PermissionFailure')
    if (classified._tag === 'PermissionFailure') {
      expect(classified.ssoRequired).toBe(true)
    }
  })

  it('classifies validation failures', () => {
    const error = Object.assign(new Error('validation failed'), {status: 422})
    const classified = classifyServiceError('github', error)
    expect(classified._tag).toBe('ValidationFailure')
  })
})
