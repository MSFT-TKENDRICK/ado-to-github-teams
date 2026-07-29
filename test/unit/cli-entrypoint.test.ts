import {describe, expect, it} from 'vitest'
import {normalizeCliArgs} from '../../src/cli.js'

describe('CLI entrypoint', () => {
  it('reopens the latest migration session when invoked without arguments', () => {
    expect(normalizeCliArgs([])).toEqual(['migrate'])
  })

  it('routes the initial sandbox flag to the migration command', () => {
    expect(normalizeCliArgs(['--sandbox', 'happy-path'])).toEqual([
      'migrate',
      '--sandbox',
      'happy-path',
    ])
    expect(normalizeCliArgs(['migrate', '--sandbox', 'happy-path'])).toEqual([
      'migrate',
      '--sandbox',
      'happy-path',
    ])
    expect(normalizeCliArgs(['--sandbox=happy-path'])).toEqual(['migrate', '--sandbox=happy-path'])
    expect(normalizeCliArgs(['--sandbox', 'auth'])).toEqual(['migrate', '--sandbox', 'auth'])
  })
})
