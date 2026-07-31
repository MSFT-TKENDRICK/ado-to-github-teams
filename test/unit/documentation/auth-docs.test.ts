import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {describe, expect, it} from 'vitest'

async function repositoryFile(file: string): Promise<string> {
  return readFile(path.join(process.cwd(), file), 'utf8')
}

describe('auth documentation acceptance', () => {
  it('keeps user, operator, security, and contributor guidance aligned', async () => {
    const [usage, testing, operations, security, contributing] = await Promise.all([
      repositoryFile('docs/using-the-cli.md'),
      repositoryFile('docs/testing.md'),
      repositoryFile('skills/ado-to-github-teams/references/operations.md'),
      repositoryFile('SECURITY.md'),
      repositoryFile('CONTRIBUTING.md'),
    ])

    expect(usage).toContain('auth --ado-org https://dev.azure.com/contoso --json')
    expect(usage).toContain('JSON mode disables browser and device fallback')
    expect(testing).toContain('32/32 flags')
    expect(testing).toContain('12/12 conflicts')
    expect(testing).toContain('10/10 operator personas')
    expect(testing).toMatch(/12,576\/12,576\s+schema-valid trace/)
    expect(testing).toContain('3,944 Cucumber records')
    expect(testing).toMatch(/introduced no new\s+unintuitive or high-harm actions/)
    expect(testing).toContain('scope repetition (mean 37.5, P95 38.6)')
    expect(testing).toMatch(/receipt must remain `continue`/)
    expect(operations).toContain('auth --ado-org https://dev.azure.com/ORG --json')
    expect(operations).toContain('JSON mode disables interactive browser and device fallback')
    expect(security).toContain('auth --json')
    expect(security).toMatch(/must be rejected before credential or\s+provider access/)
    expect(contributing).toContain('Treat documentation as an acceptance gate')
    expect(contributing).toContain('validate every `persona-actions.jsonl` line')
  })
})
