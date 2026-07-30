import {describe, expect, it} from 'vitest'
import Auth from '../../../src/commands/auth.js'

describe('auth command flags', () => {
  it('rejects json with quiet before resolving credentials', async () => {
    await expect(Auth.run(['--json', '--quiet'])).rejects.toThrow(
      'cannot also be provided when using --json',
    )
  })
})
