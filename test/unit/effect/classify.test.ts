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

  // Regression coverage for a defect found by test/chaos: Node's global `fetch` (undici) never
  // puts a transport code on the error it throws. It throws `TypeError: fetch failed` with
  // `code === undefined` and the real SocketError in `cause`. Reading only the top-level code
  // classified every socket reset and refused connection as an unrecognised error, which fell
  // through to the NON-retryable `ValidationFailure` — so a transient blip mid-migration aborted
  // the run instead of being retried. These cases pin the cause-chain traversal.
  describe('transport failures reported through a wrapper error', () => {
    it('classifies an undici socket error nested in cause as transient', () => {
      const cause = Object.assign(new Error('other side closed'), {code: 'UND_ERR_SOCKET'})
      const error = Object.assign(new TypeError('fetch failed'), {cause})
      expect(classifyServiceError('github', error)._tag).toBe('TransientFailure')
    })

    it('classifies a refused connection nested in cause as transient', () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      })
      const error = Object.assign(new TypeError('fetch failed'), {cause})
      expect(classifyServiceError('github', error)._tag).toBe('TransientFailure')
    })

    it('classifies a dual-stack AggregateError by its per-address causes', () => {
      const aggregate = new AggregateError(
        [
          Object.assign(new Error('connect ECONNREFUSED ::1:443'), {code: 'ECONNREFUSED'}),
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {code: 'ECONNREFUSED'}),
        ],
        'all attempts failed',
      )
      const error = Object.assign(new TypeError('fetch failed'), {cause: aggregate})
      expect(classifyServiceError('github', error)._tag).toBe('TransientFailure')
    })

    it('lets an explicit HTTP status win over a transient code deeper in the chain', () => {
      // Over-classification guard: a real 422 must stay a permanent ValidationFailure even when a
      // recycled socket error is still hanging off the cause chain. Retrying a 422 forever is as
      // damaging as refusing to retry a reset.
      const cause = Object.assign(new Error('other side closed'), {code: 'UND_ERR_SOCKET'})
      const error = Object.assign(new Error('validation failed'), {status: 422, cause})
      expect(classifyServiceError('github', error)._tag).toBe('ValidationFailure')
    })

    it('terminates on a cyclic cause chain', () => {
      const first = Object.assign(new Error('first'), {code: 'NOT_TRANSIENT'}) as Error & {
        cause?: unknown
      }
      const second = Object.assign(new Error('second'), {cause: first})
      first.cause = second
      expect(classifyServiceError('github', first)._tag).toBe('ValidationFailure')
    })
  })
})
