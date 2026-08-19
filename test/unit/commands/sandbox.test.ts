import {afterEach, describe, expect, it, vi} from 'vitest'
import Sandbox from '../../../src/commands/sandbox.js'

async function captureRejection(argv: string[]): Promise<unknown> {
  try {
    await Sandbox.run(argv)
  } catch (error) {
    return error
  }
  throw new Error('Expected the sandbox command to reject.')
}

describe('sandbox command', () => {
  const originalExitCode = process.exitCode

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = originalExitCode
  })

  it('describes the interactive sandbox surface and its flags', () => {
    expect(Sandbox.description).toContain('persistent interactive CLI session')
    expect(Sandbox.flags.tui.default).toBe(true)
    expect(Sandbox.flags.tui.allowNo).toBe(true)
    expect(Sandbox.flags.scenario.required).toBe(false)
    expect(Sandbox.flags['sandbox-config'].required).toBe(false)
    expect(Sandbox.examples).toHaveLength(3)
  })

  it('refuses to start without an interactive terminal and points at the one-shot forms', async () => {
    const error = await captureRejection([])

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain(
      'The sandbox session needs an interactive terminal for both keyboard input and output.',
    )
    expect(message).toContain('a2g migrate --sandbox <scenario>')
    expect(message).toContain('a2g --list-sandbox-scenarios')
    expect((error as {oclif?: {exit?: number}}).oclif?.exit).toBe(2)
  })

  it('refuses regardless of a preselected scenario when there is no terminal', async () => {
    const error = await captureRejection(['--scenario', 'happy-path'])

    expect((error as Error).message).toContain(
      'The sandbox session needs an interactive terminal for both keyboard input and output.',
    )
  })
})
