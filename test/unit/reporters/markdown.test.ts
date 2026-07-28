import {describe, expect, it} from 'vitest'
import {MarkdownReporter} from '../../../src/reporters/markdown.js'
import type {MigrationReport} from '../../../src/types/index.js'

function reportFixture(): MigrationReport {
  return {
    runId: 'run-123',
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    dryRun: true,
    mappings: [
      {
        adoTeam: {
          id: 't1',
          name: 'Core | Platform',
          projectId: 'p1',
          projectName: 'Platform',
        },
        githubTeam: {
          slug: 'core-platform',
          name: 'Core Platform',
          privacy: 'closed',
        },
        memberMappings: [
          {
            adoIdentity: {
              id: 'u1',
              displayName: 'Ada',
              uniqueName: 'ada@contoso.com',
              isContainer: false,
            },
            githubUser: {
              login: 'ada',
              type: 'User',
            },
            mapped: true,
          },
        ],
        edgeCases: [],
      },
    ],
    edgeCases: [
      {
        reason: 'missing-email',
        details: 'No email on source profile',
        recommendation: 'Add email',
      },
    ],
    skippedItems: [
      {
        type: 'member',
        name: 'core-platform:unknown',
        reason: 'No account',
      },
    ],
    failureLog: [
      {
        failureMode: 'RATE_LIMITED',
        error: 'HTTP 429',
        healingAction: 'Retry',
        userApproved: true,
        resolved: true,
      },
    ],
    approvalHistory: [
      {
        action: 'Create teams',
        context: '{"teamCount":1}',
        approved: true,
        timestamp: '2026-01-01T00:00:10.000Z',
      },
    ],
  }
}

describe('MarkdownReporter', () => {
  it('renders all required sections and escapes table content', () => {
    const reporter = new MarkdownReporter()
    const markdown = reporter.render(reportFixture(), 12_345)
    expect(markdown).toContain('## Run Summary')
    expect(markdown).toContain('## Mapped Teams')
    expect(markdown).toContain('## Member Mapping Details')
    expect(markdown).toContain('## Edge Cases')
    expect(markdown).toContain('## Skipped Items')
    expect(markdown).toContain('## Failure Log')
    expect(markdown).toContain('## Approval History')
    expect(markdown).toContain('Core \\| Platform')
  })

  it('renders empty state messages when sections are empty', () => {
    const reporter = new MarkdownReporter()
    const empty = reportFixture()
    empty.mappings = []
    empty.edgeCases = []
    empty.skippedItems = []
    empty.failureLog = []
    empty.approvalHistory = []

    const markdown = reporter.render(empty)
    expect(markdown).toContain('_No team mappings generated._')
    expect(markdown).toContain('_No edge cases detected._')
    expect(markdown).toContain('_No skipped items._')
    expect(markdown).toContain('_No failures logged._')
    expect(markdown).toContain('_No approvals recorded._')
  })
})
