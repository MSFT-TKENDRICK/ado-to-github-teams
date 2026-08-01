import {describe, expect, it} from 'vitest'
import {
  renderMigrationCompletion,
  renderOutcomeConfirmation,
} from '../../../src/ui/outcome-confirmation.js'

describe('outcome confirmation', () => {
  it('provides a reference, outcome, durable record, next step, and valid next commands', () => {
    const lines = renderOutcomeConfirmation({
      title: 'Migration complete.',
      reference: 'run-123',
      result: 'GitHub changes were applied and the durable workflow completed.',
      record: 'C:\\reports\\migration-run-123.md',
      nextStep: 'Review the report and resolve any edge cases.',
      nextCommands: ['a2g sessions', 'a2g'],
    })

    expect(lines).toEqual([
      'Migration complete.',
      'Reference: run-123',
      'Result: GitHub changes were applied and the durable workflow completed.',
      'Record: C:\\reports\\migration-run-123.md',
      'Next step: Review the report and resolve any edge cases.',
      'Next commands:',
      '  a2g sessions',
      '  a2g',
    ])
  })

  it('uses the normal completion structure with sandbox safety and sandbox-only next commands', () => {
    const lines = renderMigrationCompletion({
      runId: 'sandbox-happy-path-run',
      reportPath: 'sandbox-report-happy-path.md',
      apply: false,
      sandboxScenario: 'happy-path',
    })

    expect(lines[0]).toBe('Migration complete.')
    expect(lines.join('\n')).toContain('Synthetic sandbox scenario happy-path')
    expect(lines.join('\n')).toContain('no provider writes occurred')
    expect(lines).toContain('  a2g migrate --sandbox apply-happy-path --apply')
    expect(lines.join('\n')).not.toContain('a2g auth')
  })
})
