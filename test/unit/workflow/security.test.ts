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

  it('scopes task tokens to a migration run', () => {
    const token = createTaskToken(secret, 'run-1')
    expect(verifyTaskToken(secret, 'run-1', token)).toBe(true)
    expect(verifyTaskToken(secret, 'run-2', token)).toBe(false)
  })
})
