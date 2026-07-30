import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {describe, expect, it} from 'vitest'

async function repositoryFile(file: string): Promise<string> {
  return readFile(path.join(process.cwd(), file), 'utf8')
}

describe('auth documentation acceptance', () => {
  it('keeps user, operator, security, and contributor guidance aligned', async () => {
    const [readme, operations, security, contributing] = await Promise.all([
      repositoryFile('README.md'),
      repositoryFile('skills/ado-to-github-teams/references/operations.md'),
      repositoryFile('SECURITY.md'),
      repositoryFile('CONTRIBUTING.md'),
    ])

    expect(readme).toContain('auth [--ado-org <url>] [--json | --quiet]')
    expect(readme).toContain('27/27 flags')
    expect(readme).toContain('9/9 important conflicts')
    expect(readme).toContain('8,624/8,624 valid trace')
    expect(readme).toContain('immutable corrected lower-layer evidence')
    expect(readme).toContain('P95 26.4 with 0/8')
    expect(readme).toContain('ranking correctly')
    expect(readme).toContain('JSON mode disables interactive')
    expect(operations).toContain('auth --ado-org https://dev.azure.com/ORG --json')
    expect(operations).toContain('JSON mode disables interactive browser and device fallback')
    expect(security).toContain('auth --json')
    expect(security).toMatch(/must be rejected before credential or\s+provider access/)
    expect(contributing).toContain('Treat documentation as an acceptance gate')
    expect(contributing).toContain('validate every `persona-actions.jsonl` line')
  })
})
