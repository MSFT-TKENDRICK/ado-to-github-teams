import {describe, expect, it, vi} from 'vitest'
import {normalizeCliArgs, runCli} from '../../src/cli.js'

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

  it('renders task-oriented root help through the executable entrypoint', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runCli(['--help'])

    expect(log).toHaveBeenCalledOnce()
    const output = String(log.mock.calls[0]?.[0])
    expect(output).toContain('Start by task:')
    expect(output).toContain('Preview a migration safely')
    expect(output).toContain('No arguments reopen the latest compatible durable session.')
    expect(output).toContain('ado-to-github-teams sessions --blocked --select')
    log.mockRestore()
  })
})
