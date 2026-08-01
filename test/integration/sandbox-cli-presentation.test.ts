import {execFile} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {describe, expect, it} from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

async function runDev(arguments_: readonly string[]): Promise<string> {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `npm run dev -- ${arguments_.join(' ')}`]
      : ['run', 'dev', '--', ...arguments_]
  const {stdout} = await execFileAsync(command, args, {
    cwd: repositoryRoot,
    env: {...process.env, NO_COLOR: '1'},
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

describe('sandbox CLI presentation', () => {
  it('runs the contributor onboarding command through the production progress and completion path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sandbox-cli-presentation-'))
    const reportPath = path.join(directory, 'report.md')
    try {
      const stdout = await runDev(['migrate', '--sandbox', 'happy-path', '--output', reportPath])
      const progressLines = stdout
        .split(/\r?\n/)
        .filter((line) => /^\[(?:LIVE|COMPLETE)\]/.test(line))
      const runIds = new Set(
        progressLines.map((line) => line.match(/^\[[A-Z]+\] ([^ ]+)/)?.[1]).filter(Boolean),
      )

      expect(progressLines.map((line) => line.split(' · ')[2])).toEqual([
        'Discovering source teams',
        'Discovering source teams',
        'Matching people and teams',
        'Reviewing the proposed migration',
        'Migration workflow complete',
      ])
      expect(runIds.size).toBe(1)
      expect(stdout).toContain('SANDBOX DRY RUN • NO PROVIDER WRITES')
      expect(stdout).toContain('Migration complete.')
      expect(stdout).toContain('Synthetic sandbox scenario happy-path')
      expect(stdout).toContain('a2g migrate --sandbox apply-happy-path --apply')
      expect(stdout).not.toContain('a2g auth --ado-org')

      const report = await readFile(reportPath, 'utf8')
      expect(report).toContain('SANDBOX — NO PROVIDER WRITES WERE PERFORMED.')
      expect(report).toContain('## Sandbox Boundary Transcript')
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  }, 60_000)

  it('preserves predefined apply decisions while presenting their exact scope and writes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'sandbox-cli-apply-presentation-'))
    const reportPath = path.join(directory, 'report.md')
    try {
      const stdout = await runDev([
        'migrate',
        '--sandbox',
        'apply-happy-path',
        '--apply',
        '--yes',
        '--output',
        reportPath,
      ])

      expect(stdout).toContain('Approval required: Create 1 teams in contoso')
      expect(stdout).toContain('Exact proposed writes (1):')
      expect(stdout).toContain('core:ada')
      expect(stdout).not.toContain('Approve exactly these target writes?')
      expect(stdout).toContain('Synthetic sandbox scenario apply-happy-path')
      expect(await readFile(reportPath, 'utf8')).toContain('**Mode:** Apply')
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  }, 60_000)
})
