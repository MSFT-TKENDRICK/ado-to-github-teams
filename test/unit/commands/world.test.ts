import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import World from '../../../src/commands/world.js'

const worldPath = path.join(homedir(), '.ado-github-teams', 'world.json')

function captureStdout(): string[] {
  const collected: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    collected.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  return collected
}

describe('world command', () => {
  let originalWorld: string | null = null
  const originalExitCode = process.exitCode

  beforeAll(async () => {
    try {
      originalWorld = await readFile(worldPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      originalWorld = null
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = originalExitCode
  })

  afterAll(async () => {
    if (originalWorld === null) {
      await rm(worldPath, {force: true})
      return
    }
    await mkdir(path.dirname(worldPath), {recursive: true})
    await writeFile(worldPath, originalWorld, 'utf8')
  })

  it('declares mutually exclusive local and subscription flags', () => {
    expect(World.flags.local.exclusive).toContain('subscription')
    expect(World.flags.subscription.exclusive).toContain('local')
    expect(World.flags.local.default).toBe(false)
    expect(World.description).toContain('local preference')
  })

  it('rejects combining --local with --subscription', async () => {
    await expect(World.run(['--local', '--subscription', 'sub-123'])).rejects.toThrow(
      /cannot also be provided when using/i,
    )
  })

  it('records the local deployment preference without contacting Azure', async () => {
    const stdout = captureStdout()

    await World.run(['--local'])

    const output = stdout.join('')
    expect(output).toContain(
      'Local deployment preference recorded. Azure sign-in and a subscription are not required.',
    )

    const persisted = JSON.parse(await readFile(worldPath, 'utf8')) as {provider: string}
    expect(persisted.provider).toBe('local')
  })
})
