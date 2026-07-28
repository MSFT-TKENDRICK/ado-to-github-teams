import {describe, expect, it} from 'vitest'

import {runCli} from '../../src/index.js'

const capture = () => {
  const stdout: string[] = []
  const stderr: string[] = []

  return {
    stderr,
    stdout,
    io: {
      stderr: (message: string) => stderr.push(message),
      stdout: (message: string) => stdout.push(message),
    },
  }
}

describe('runCli', () => {
  it('prints a version without invoking migration behavior', () => {
    const output = capture()

    expect(runCli(['--version'], output.io)).toBe(0)
    expect(output.stdout).toEqual(['ado-to-github-teams 0.1.0'])
    expect(output.stderr).toEqual([])
  })

  it('rejects unknown options with a non-zero result', () => {
    const output = capture()

    expect(runCli(['--unknown'], output.io)).toBe(2)
    expect(output.stderr[0]).toBe('Unknown option: --unknown')
  })
})
