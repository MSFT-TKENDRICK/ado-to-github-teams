import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Effect} from 'effect'
import {afterEach, describe, expect, it} from 'vitest'
import {writeJsonFile} from '../../../src/plans/io.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, {recursive: true, force: true})
  }
})

describe('plan artifact file output', () => {
  it('writes complete JSON and refuses to overwrite an existing destination', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'migration-plan-'))
    temporaryDirectories.push(directory)
    const output = path.join(directory, 'plan.json')

    await Effect.runPromise(writeJsonFile(output, {plan: 'first'}))
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({plan: 'first'})
    await expect(Effect.runPromise(writeJsonFile(output, {plan: 'second'}))).rejects.toThrow(
      'destination must not already exist',
    )
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({plan: 'first'})
  })
})
