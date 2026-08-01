import {execute} from '@oclif/core'
import {describe, expect, it, vi} from 'vitest'
import {
  isSandboxHelpRequest,
  isSourceEntrypoint,
  normalizeCliArgs,
  runCli,
  sandboxConfigPath,
} from '../../src/cli.js'

vi.mock('@oclif/core', () => ({
  execute: vi.fn(async () => undefined),
}))

describe('CLI entrypoint', () => {
  it('reopens the latest migration session when invoked without arguments', () => {
    expect(normalizeCliArgs([])).toEqual(['migrate'])
  })

  it('routes top-level sandbox aliases to the persistent sandbox command', () => {
    expect(normalizeCliArgs(['--sandbox'])).toEqual(['sandbox'])
    expect(normalizeCliArgs(['--sandbox', '--no-tui'])).toEqual(['sandbox', '--no-tui'])
    expect(normalizeCliArgs(['--sandbox', 'happy-path'])).toEqual([
      'sandbox',
      '--scenario',
      'happy-path',
    ])
    expect(normalizeCliArgs(['--sandbox', 'happy-path', '--no-tui'])).toEqual([
      'sandbox',
      '--scenario',
      'happy-path',
      '--no-tui',
    ])
    expect(normalizeCliArgs(['migrate', '--sandbox', 'happy-path'])).toEqual([
      'migrate',
      '--sandbox',
      'happy-path',
    ])
    expect(normalizeCliArgs(['--sandbox=happy-path'])).toEqual([
      'sandbox',
      '--scenario',
      'happy-path',
    ])
    expect(normalizeCliArgs(['--sandbox='])).toEqual(['sandbox', '--scenario', ''])
    expect(normalizeCliArgs(['--sandbox', 'auth'])).toEqual(['sandbox', '--scenario', 'auth'])
  })

  it('recognizes interactive sandbox help and custom catalogs', () => {
    expect(isSandboxHelpRequest(['sandbox', '--help'])).toBe(true)
    expect(isSandboxHelpRequest(['--sandbox', '-h'])).toBe(true)
    expect(isSandboxHelpRequest(['--sandbox=happy-path', '--help'])).toBe(true)
    expect(isSandboxHelpRequest(['--sandbox', 'happy-path'])).toBe(false)
    expect(sandboxConfigPath(['sandbox', '--sandbox-config', 'custom.yaml', '--help'])).toBe(
      'custom.yaml',
    )
    expect(sandboxConfigPath(['sandbox', '--sandbox-config=custom.yaml', '--help'])).toBe(
      'custom.yaml',
    )
    expect(sandboxConfigPath(['sandbox', '--sandbox-config', '--help'])).toBeUndefined()
  })

  it('uses oclif development discovery only for the TypeScript source entrypoint', () => {
    expect(isSourceEntrypoint('file:///repo/src/cli.ts')).toBe(true)
    expect(isSourceEntrypoint('file:///repo/dist/cli.js')).toBe(false)
  })

  it('enables oclif development discovery when the TypeScript entrypoint runs directly', async () => {
    await runCli(['migrate', '--help'])

    expect(execute).toHaveBeenCalledWith({
      args: ['migrate', '--help'],
      development: true,
      dir: expect.stringMatching(/\/src\/cli\.ts$/),
    })
  })

  it('renders task-oriented root help through the executable entrypoint', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runCli(['--help'])

    expect(log).toHaveBeenCalledOnce()
    const output = String(log.mock.calls[0]?.[0])
    expect(output).toContain('Start by task:')
    expect(output).toContain('Preview a migration safely')
    expect(output).toContain('No arguments reopen the latest compatible durable session.')
    expect(output).toContain('a2g sessions --blocked --select')
    expect(output).toContain('a2g sandbox')
    log.mockRestore()
  })

  it('renders catalog-driven help for the interactive sandbox', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runCli(['sandbox', '--help'])

    expect(log).toHaveBeenCalledOnce()
    const output = String(log.mock.calls[0]?.[0])
    expect(output).toContain('One terminal surface stays mounted from launch until you exit it.')
    expect(output).toContain('happy-path [dry-run]')
    expect(output).toContain('apply-happy-path [apply]')
    expect(output).toContain('Predetermined service result:')
    expect(output).toContain('Preselect a scenario in the list; it never starts on its own.')
    expect(output).toContain('a2g migrate --sandbox <scenario>')
    expect(output).toContain('--no-tui')
    log.mockRestore()
  })

  it('routes an unknown command to safe task guidance before oclif execution', async () => {
    const previousExitCode = process.exitCode
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await runCli(['frobnicate'])

    expect(process.exitCode).toBe(2)
    expect(error).toHaveBeenCalledOnce()
    const output = String(error.mock.calls[0]?.[0])
    expect(output).toContain('Problem: command frobnicate not found')
    expect(output).toContain('a2g --help')
    expect(output).toContain('a2g migrate --ado-org <url>')
    error.mockRestore()
    process.exitCode = previousExitCode
  })
})
