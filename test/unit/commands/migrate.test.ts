import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import path from 'node:path'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import Migrate from '../../../src/commands/migrate.js'

function captureStdout(): string[] {
  const collected: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    collected.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  return collected
}

describe('migrate command', () => {
  let workDir: string
  let reportCounter = 0
  const originalToken = process.env.WORKFLOW_API_TOKEN
  const originalExitCode = process.exitCode

  function reportPath(): string {
    reportCounter += 1
    return path.join(workDir, `report-${reportCounter}.md`)
  }

  beforeAll(() => {
    workDir = mkdtempSync(path.join(process.cwd(), 'migrate-test-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = originalExitCode
    if (originalToken === undefined) {
      delete process.env.WORKFLOW_API_TOKEN
    } else {
      process.env.WORKFLOW_API_TOKEN = originalToken
    }
  })

  afterAll(() => {
    rmSync(workDir, {recursive: true, force: true})
  })

  describe('flag surface', () => {
    it('keeps dry-run as the default and exposes live-scope aliases', () => {
      expect(Migrate.flags.apply.default).toBe(false)
      expect(Migrate.flags.tui.default).toBe(true)
      expect(Migrate.flags.tui.allowNo).toBe(true)
      expect(Migrate.flags.concurrency.default).toBe(4)
      expect(Migrate.flags['ado-org'].aliases).toContain('source-org')
      expect(Migrate.flags['ado-project'].aliases).toContain('source-project')
      expect(Migrate.flags['github-org'].aliases).toContain('target-org')
    })
  })

  describe('preflight refusals', () => {
    it('rejects --yes outside sandbox scenarios', async () => {
      await expect(Migrate.run(['--yes'])).rejects.toThrow(
        '--yes is only available for sandbox scenarios',
      )
    })

    it('rejects --sandbox-config without --sandbox or --list-sandbox-scenarios', async () => {
      await expect(Migrate.run(['--sandbox-config', './scenarios.yaml'])).rejects.toThrow(
        '--sandbox-config requires --sandbox or --list-sandbox-scenarios.',
      )
    })

    it('rejects combining --team-topology with --prefix', async () => {
      await expect(
        Migrate.run(['--team-topology', './topology.yaml', '--prefix', 'team-']),
      ).rejects.toThrow('--team-topology cannot be combined with --prefix')
    })

    it('rejects combining --team-topology with --suffix', async () => {
      await expect(
        Migrate.run(['--team-topology', './topology.yaml', '--suffix', '-team']),
      ).rejects.toThrow('--team-topology cannot be combined with --suffix')
    })

    it('rejects combining --fresh with --resume', async () => {
      await expect(Migrate.run(['--fresh', '--resume', 'run-42'])).rejects.toThrow(
        '--fresh cannot be combined with --resume',
      )
    })

    it('rejects an incomplete live scope and names the missing flags', async () => {
      await expect(Migrate.run(['--ado-org', 'https://dev.azure.com/contoso'])).rejects.toThrow(
        'Live migration requires a complete scope; missing --ado-project, --github-org.',
      )
    })

    it('rejects a non-positive concurrency', async () => {
      await expect(Migrate.run(['--concurrency', '0'])).rejects.toThrow(
        '--concurrency must be a positive integer.',
      )
    })

    it('rejects --resume alongside a sandbox scenario before loading the catalog', async () => {
      await expect(
        Migrate.run(['--sandbox', 'apply-happy-path', '--resume', 'run-1']),
      ).rejects.toThrow('Sandbox scenarios do not support --resume')
    })

    it('rejects --team-topology alongside a sandbox scenario', async () => {
      await expect(
        Migrate.run(['--sandbox', 'happy-path', '--team-topology', './topology.yaml']),
      ).rejects.toThrow('Sandbox scenarios do not currently accept --team-topology.')
    })

    it('rejects --apply against a dry-run sandbox scenario in the scenario-aware preflight', async () => {
      await expect(Migrate.run(['--sandbox', 'happy-path', '--apply'])).rejects.toThrow(
        'Sandbox scenario "happy-path" is a dry-run scenario and does not accept --apply.',
      )
    })

    it('requires --apply for an apply-mode sandbox scenario', async () => {
      await expect(Migrate.run(['--sandbox', 'apply-happy-path'])).rejects.toThrow(
        'Sandbox scenario "apply-happy-path" requires --apply',
      )
    })
  })

  describe('sandbox one-shot execution', () => {
    it('lists the bundled sandbox scenario catalog', async () => {
      const stdout = captureStdout()

      await Migrate.run(['--list-sandbox-scenarios'])

      const output = stdout.join('')
      expect(output).toContain('happy-path')
      expect(output).toContain('dry-run')
      expect(output).toContain('apply-happy-path')
      expect(output).toContain('apply')
    })

    it('runs the happy-path dry-run scenario fully offline and confirms no writes', async () => {
      const stdout = captureStdout()

      await Migrate.run(['--sandbox', 'happy-path', '--output', reportPath(), '--no-tui'])

      const output = stdout.join('')
      expect(output).toContain('SANDBOX: happy-path — no provider writes will be performed.')
      expect(output).toContain('Migration complete.')
      expect(output).toContain(
        'Synthetic sandbox scenario happy-path completed through production orchestration',
      )
      expect(output).toContain('a2g migrate --sandbox apply-happy-path --apply')
    })

    it('presents the exact proposed writes before honoring predefined apply approvals', async () => {
      const output = reportPath()
      const stdout = captureStdout()

      await Migrate.run([
        '--sandbox',
        'apply-happy-path',
        '--apply',
        '--yes',
        '--output',
        output,
        '--no-tui',
      ])

      const text = stdout.join('')
      expect(text).toContain('SANDBOX: apply-happy-path — no provider writes will be performed.')
      expect(text).toContain('Approval required: Create 1 teams in contoso')
      expect(text).toContain('Exact proposed writes (1):')
      expect(text).toContain('core:ada')
      expect(text).not.toContain('Approve exactly these target writes?')
      expect(text).toContain(
        'Durable record: the decision and its exact context are stored in migration approval history before execution.',
      )
      expect(text).toContain(
        'Synthetic sandbox scenario apply-happy-path completed through production orchestration',
      )
      expect(existsSync(output)).toBe(true)
    })

    it('surfaces a scenario expected failure without aborting the process', async () => {
      const stdout = captureStdout()

      await Migrate.run([
        '--sandbox',
        'github-lookup-failure',
        '--output',
        reportPath(),
        '--no-tui',
      ])

      expect(stdout.join('')).toContain('Scenario reached its expected failure:')
    })
  })

  describe('live migration preconditions', () => {
    it('refuses to start a live run without a sufficiently long worker token', async () => {
      delete process.env.WORKFLOW_API_TOKEN

      await expect(
        Migrate.run([
          '--ado-org',
          'https://dev.azure.com/contoso',
          '--ado-project',
          'Engineering',
          '--github-org',
          'contoso',
        ]),
      ).rejects.toThrow('WORKFLOW_API_TOKEN must contain at least 32 characters.')
    })
  })
})
