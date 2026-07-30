import {describe, expect, it} from 'vitest'
import {
  decodePresentationMode,
  presentationModeDescription,
} from '../../../src/ui/adaptive-detail.js'

describe('adaptive detail', () => {
  it('decodes supported modes and rejects unsupported input', () => {
    expect(decodePresentationMode('guided')).toBe('guided')
    expect(decodePresentationMode('compact')).toBe('compact')
    expect(() => decodePresentationMode('verbose')).toThrow()
  })

  it('makes the equivalent safety-content promise explicit', () => {
    expect(presentationModeDescription('guided')).toContain('safety facts')
    expect(presentationModeDescription('compact')).toContain('same safety facts')
  })
})
