import {describe, expect, it} from 'vitest'
import {
  createTaskToken,
  verifyOpaqueToken,
  verifyTaskToken,
} from '../../../src/workflow/security.js'

describe('workflow token verification', () => {
  const secret = 'test-task-secret-with-at-least-32-characters'

  it('accepts only an exact opaque token', () => {
    expect(verifyOpaqueToken('expected-token', 'expected-token')).toBe(true)
    expect(verifyOpaqueToken('expected-token', 'expected-tokee')).toBe(false)
    expect(verifyOpaqueToken('expected-token', 'short')).toBe(false)
  })

  it('scopes task tokens to a migration run and workflow step', () => {
    const token = createTaskToken(secret, 'run-1', 'prepare')
    expect(verifyTaskToken(secret, 'run-1', 'prepare', token)).toBe(true)
    expect(verifyTaskToken(secret, 'run-2', 'prepare', token)).toBe(false)
  })

  it('rejects a token minted for a different workflow step (replay across steps)', () => {
    const prepareToken = createTaskToken(secret, 'run-1', 'prepare')
    expect(verifyTaskToken(secret, 'run-1', 'apply', prepareToken)).toBe(false)
    expect(
      verifyTaskToken(secret, 'run-1', 'escalation', prepareToken),
    ).toBe(false)
    expect(verifyTaskToken(secret, 'run-1', 'prepare', prepareToken)).toBe(
      true,
    )
  })
})
