import {describe, expect, it} from 'vitest'
import {classifyServiceError} from '../../../src/effect/classify.js'
import {CircuitOpenError} from '../../../src/healing/retry.js'
import {PermissionError} from '../../../src/utils/errors.js'

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

  it('classifies wrapped permission errors without losing the failure kind', () => {
    const classified = classifyServiceError(
      'github',
      new PermissionError('GitHub access denied during POST team Example', 403),
    )
    expect(classified._tag).toBe('PermissionFailure')
    if (classified._tag === 'PermissionFailure') {
      expect(classified.status).toBe(403)
      expect(classified.ssoRequired).toBe(false)
    }
  })

  it('classifies retry exhaustion using the last transient error', () => {
    const lastError = Object.assign(new Error('upstream unavailable'), {
      status: 503,
      response: {status: 503, headers: {'retry-after': '2'}},
    })
    const classified = classifyServiceError(
      'github',
      new CircuitOpenError('Retry circuit opened after 5 attempts', lastError),
    )
    expect(classified._tag).toBe('TransientFailure')
    if (classified._tag === 'TransientFailure') {
      expect(classified.status).toBe(503)
      expect(classified.retryAfterMs).toBe(2000)
    }
  })
})
