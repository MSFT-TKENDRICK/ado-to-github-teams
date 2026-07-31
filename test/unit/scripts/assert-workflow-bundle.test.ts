import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {assertWorkflowBundle} from '../../../scripts/assert-workflow-bundle.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, {recursive: true, force: true})),
  )
})

async function writeBundle(manifest: object): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'a2g-workflow-bundle-'))
  temporaryDirectories.push(directory)
  await Promise.all([
    writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8'),
    writeFile(path.join(directory, 'workflows.mjs'), 'export async function POST() {}\n', 'utf8'),
    writeFile(path.join(directory, 'steps.mjs'), 'export async function POST() {}\n', 'utf8'),
  ])
  return directory
}

describe('Workflow bundle assertion', () => {
  it('accepts non-empty registries with generated handlers', async () => {
    const directory = await writeBundle({
      workflows: {migrationWorkflow: {}},
      steps: {prepareMigration: {}},
    })

    await expect(assertWorkflowBundle(directory)).resolves.toEqual({workflows: 1, steps: 1})
  })

  it('rejects empty registries even when handler modules exist', async () => {
    const directory = await writeBundle({workflows: {}, steps: {}})

    await expect(assertWorkflowBundle(directory)).rejects.toThrow(
      'Workflow compilation produced an empty registry',
    )
  })
})
