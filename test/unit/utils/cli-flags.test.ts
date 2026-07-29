import {describe, expect, it} from 'vitest'
import {wasCliFlagProvided} from '../../../src/utils/cli-flags.js'

describe('CLI flag detection', () => {
  it('recognizes separate and equals-style flag values', () => {
    expect(wasCliFlagProvided(['--concurrency', '8'], '--concurrency')).toBe(true)
    expect(wasCliFlagProvided(['--concurrency=8'], '--concurrency')).toBe(true)
    expect(wasCliFlagProvided(['--apply=true'], '--apply')).toBe(true)
    expect(wasCliFlagProvided([], '--concurrency')).toBe(false)
  })
})
