import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import Migrate from '../../../src/commands/migrate.js'
import Auth from '../../../src/commands/auth.js'
import Sessions from '../../../src/commands/sessions.js'
import {renderRootHelp} from '../../../src/ui/command-guidance.js'

async function repositoryFile(file: string): Promise<string> {
  return readFile(path.join(process.cwd(), file), 'utf8')
}

describe('CLI guidance documentation acceptance', () => {
  it('keeps executable help, user guidance, operator guidance, and security behavior aligned', async () => {
    const [usage, operations, security] = await Promise.all([
      repositoryFile('docs/using-the-cli.md'),
      repositoryFile('skills/ado-to-github-teams/references/operations.md'),
      repositoryFile('SECURITY.md'),
    ])
    const help = renderRootHelp()

    expect(help).toContain('Start by task:')
    expect(help).toContain('No arguments reopen the latest compatible durable session.')
    expect(help).toContain('ado-to-github-teams sessions --blocked --select')
    expect(Migrate.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: '<%= config.bin %> <%= command.id %> --resume <run-id> --foreground',
        }),
        expect.objectContaining({
          command: expect.stringContaining(
            '--source-org https://dev.azure.com/contoso --source-project Platform --target-org contoso',
          ),
        }),
      ]),
    )
    expect(Migrate.flags['ado-org'].aliases).toEqual(['source-org'])
    expect(Migrate.flags['ado-project'].aliases).toEqual(['source-project'])
    expect(Migrate.flags['github-org'].aliases).toEqual(['target-org'])
    expect(Migrate.flags['ado-org'].helpGroup).toBe('LIVE SCOPE (REQUIRED TOGETHER)')
    expect(Migrate.flags.apply.helpGroup).toBe('EXECUTION')
    expect(Migrate.flags.detail.helpGroup).toBe('PRESENTATION')
    expect(Migrate.flags.resume.helpGroup).toBe('RECOVERY')
    expect(Migrate.flags['team-topology'].helpGroup).toBe('NAMING AND TOPOLOGY')
    expect(Migrate.flags.sandbox.helpGroup).toBe('SANDBOX (SIMULATED PROVIDERS)')
    expect(Migrate.flags['worker-url'].helpGroup).toBe('WORKER')
    expect(Auth.flags['ado-org'].aliases).toEqual(['source-org'])
    expect(Auth.flags['ado-org'].helpGroup).toBe('SCOPE')
    expect(Sessions.flags.detail.helpGroup).toBe('PRESENTATION')
    expect(Sessions.flags['worker-url'].helpGroup).toBe('WORKER')
    expect(usage).toContain('Invalid migration input exits 2 on stderr')
    expect(usage).toContain('MigrationCommandPreflightFailure')
    expect(usage).toContain('Unknown commands also exit 2')
    expect(usage).toContain('Build commands from flag groups')
    expect(usage).toContain('--source-org')
    expect(usage).toContain('Named persisted scope profiles are not supported')
    expect(operations).toMatch(/preflight rejection\s+exits 2/)
    expect(operations).toContain('Named scope profiles are not supported or persisted')
    expect(security).toMatch(/rejected command must exit 2/)
    expect(security).toContain('not a separate configuration source')
  })
})
