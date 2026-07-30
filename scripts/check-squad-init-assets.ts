import {initSquad} from '@bradygaster/squad-sdk/config'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import squadConfig from '../squad.config.ts'
import {createSquadInitOptions} from './squad-init.js'

const repositoryRoot = process.cwd()
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ado-github-teams-squad-check-'))

const listSkillNames = async (root: string): Promise<string[]> =>
  (await readdir(join(root, '.github', 'skills'), {withFileTypes: true}))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

const normalizeEol = (content: string): string => content.replaceAll('\r\n', '\n')

try {
  const result = await initSquad(createSquadInitOptions(temporaryRoot))
  if (result.warnings && result.warnings.length > 0) {
    throw new Error(`Squad asset check warnings: ${result.warnings.join('; ')}`)
  }

  const configuredSkillNames = new Set(squadConfig.skills?.map((skill) => skill.name) ?? [])
  const expectedFrameworkSkills = await listSkillNames(temporaryRoot)
  const actualFrameworkSkills = (await listSkillNames(repositoryRoot)).filter(
    (name) => !configuredSkillNames.has(name),
  )
  const mismatches: string[] = []

  if (JSON.stringify(actualFrameworkSkills) !== JSON.stringify(expectedFrameworkSkills)) {
    mismatches.push('.github/skills framework skill inventory')
  }

  const pinnedInitAssets = [
    '.github/agents/squad.agent.md',
    '.squad/fact-checker/policy.md',
    '.squad/memory/config.json',
    '.squad/rai/policy.md',
    ...expectedFrameworkSkills.map((name) => `.github/skills/${name}/SKILL.md`),
  ]

  await Promise.all(
    pinnedInitAssets.map(async (relativePath) => {
      const [expected, actual] = await Promise.all([
        readFile(join(temporaryRoot, relativePath), 'utf8'),
        readFile(join(repositoryRoot, relativePath), 'utf8'),
      ])

      if (normalizeEol(actual) !== normalizeEol(expected)) {
        mismatches.push(relativePath)
      }
    }),
  )

  const generatedConfig = JSON.parse(
    await readFile(join(temporaryRoot, '.squad', 'config.json'), 'utf8'),
  ) as Record<string, unknown>
  const committedConfig = JSON.parse(
    await readFile(join(repositoryRoot, '.squad', 'config.json'), 'utf8'),
  ) as Record<string, unknown>
  const expectedConfig = {...generatedConfig, stateBackend: 'local'}
  if (JSON.stringify(committedConfig) !== JSON.stringify(expectedConfig)) {
    mismatches.push('.squad/config.json')
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Committed Squad init assets drifted from the pinned SDK:\n${mismatches
        .sort()
        .map((path) => `- ${path}`)
        .join('\n')}`,
    )
  }

  console.log(`${pinnedInitAssets.length + 1} pinned Squad init assets match the SDK.`)
} finally {
  await rm(temporaryRoot, {recursive: true, force: true})
}
