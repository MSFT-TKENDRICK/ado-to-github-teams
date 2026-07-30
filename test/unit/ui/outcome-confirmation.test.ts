import {describe, expect, it} from 'vitest'
import {renderOutcomeConfirmation} from '../../../src/ui/outcome-confirmation.js'

describe('outcome confirmation', () => {
  it('provides a reference, outcome, durable record, next step, and valid next commands', () => {
    const lines = renderOutcomeConfirmation({
      title: 'Migration complete.',
      reference: 'run-123',
      result: 'GitHub changes were applied and the durable workflow completed.',
      record: 'C:\\reports\\migration-run-123.md',
      nextStep: 'Review the report and resolve any edge cases.',
      nextCommands: ['ado-to-github-teams sessions', 'ado-to-github-teams'],
    })

    expect(lines).toEqual([
      'Migration complete.',
      'Reference: run-123',
      'Result: GitHub changes were applied and the durable workflow completed.',
      'Record: C:\\reports\\migration-run-123.md',
      'Next step: Review the report and resolve any edge cases.',
      'Next commands:',
      '  ado-to-github-teams sessions',
      '  ado-to-github-teams',
    ])
  })
})
