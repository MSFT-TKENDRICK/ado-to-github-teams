import {describe, expect, it} from 'vitest'
import {
  COMMAND_TASKS,
  isRootHelpRequest,
  isUnknownCommandError,
  renderCliCommand,
  renderRootHelp,
  unknownCommand,
} from '../../../src/ui/command-guidance.js'

describe('command guidance', () => {
  it('maps every supported operator goal to a valid starting command', () => {
    expect(COMMAND_TASKS).toHaveLength(5)
    expect(COMMAND_TASKS.every((task) => task.command.startsWith('ado-to-github-teams'))).toBe(true)
    expect(renderRootHelp()).toContain('Safety: dry-run is the default.')
  })

  it('quotes command values without obscuring placeholders', () => {
    expect(
      renderCliCommand(['ado-to-github-teams', 'migrate', '--ado-project', 'Core Platform']),
    ).toBe('ado-to-github-teams migrate --ado-project "Core Platform"')
    expect(renderCliCommand(['ado-to-github-teams', 'auth', '--ado-org', '<url>'])).toBe(
      'ado-to-github-teams auth --ado-org <url>',
    )
  })

  it('recognizes root help and unknown command failures precisely', () => {
    expect(isRootHelpRequest(['--help'])).toBe(true)
    expect(isRootHelpRequest(['migrate', '--help'])).toBe(false)
    expect(isUnknownCommandError(new Error('command frobnicate not found'))).toBe(true)
    expect(isUnknownCommandError(new Error('Provider not found'))).toBe(false)
    expect(unknownCommand(['frobnicate'])).toBe('frobnicate')
    expect(unknownCommand(['migrate', '--help'])).toBeUndefined()
    expect(unknownCommand(['--version'])).toBeUndefined()
  })
})
