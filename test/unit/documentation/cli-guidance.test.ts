import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import Migrate from '../../../src/commands/migrate.js'
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
      ]),
    )
    expect(usage).toContain('Invalid migration input exits 2 on stderr')
    expect(usage).toContain('MigrationCommandPreflightFailure')
    expect(usage).toContain('Unknown commands also exit 2')
    expect(operations).toMatch(/preflight rejection\s+exits 2/)
    expect(security).toMatch(/rejected command must exit 2/)
  })
})
