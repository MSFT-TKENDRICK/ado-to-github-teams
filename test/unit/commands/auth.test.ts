import {describe, expect, it} from 'vitest'
import Auth from '../../../src/commands/auth.js'

describe('auth command flags', () => {
  it('keeps generated help metadata aligned with the documented auth contract', () => {
    expect(Object.keys(Auth.flags).sort()).toEqual(['ado-org', 'json', 'quiet'])
    expect(Auth.flags.json.exclusive).toEqual(['quiet'])
    expect(Auth.flags.json.description).toContain('Disable interactive fallback')
    expect(Auth.flags.quiet.exclusive).toEqual(['json'])
    expect(Auth.flags['ado-org'].description).toContain('required to validate ADO access')
    expect(Auth.examples.map((example) => example.command)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('--ado-org https://dev.azure.com/contoso'),
        expect.stringContaining('--ado-org https://dev.azure.com/contoso --json'),
        expect.stringContaining('--quiet'),
      ]),
    )
  })

  it('rejects json with quiet before resolving credentials', async () => {
    await expect(Auth.run(['--json', '--quiet'])).rejects.toThrow(
      'cannot also be provided when using --json',
    )
  })
})
