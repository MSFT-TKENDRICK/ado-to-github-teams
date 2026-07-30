import {describe, expect, it} from 'vitest'
import {
  approvalPrompt,
  migrationApprovalPrompt,
  renderApprovalRequestContext,
  renderMigrationApprovalContext,
  renderMigrationPlanContext,
} from '../../../src/ui/approval-context.js'

describe('decision-centered approval context', () => {
  it('colocates exact phase writes, consequences, decline behavior, and durable evidence', () => {
    const request = {
      action: 'Add 1 member across 1 team',
      context: {githubOrg: 'contoso', teamCount: 1, memberCount: 1},
      displayLines: ['engineering:maya'],
      autoApprovable: false,
    }

    const output = renderApprovalRequestContext(request)

    expect(output).toContain('  - engineering:maya')
    expect(output.join('\n')).toMatch(/not automatically rolled back/i)
    expect(output.join('\n')).toMatch(/If declined: this proposed unit is not written/i)
    expect(output.join('\n')).toMatch(/stored in migration approval history before execution/i)
    expect(approvalPrompt(request)).toBe('Approve exactly these target writes?')
  })

  it('presents the complete migration plan and safe alternatives before approval', () => {
    const output = renderMigrationApprovalContext({
      runId: 'run-123',
      reportPath: 'migration-report-run-123.md',
      plan: {
        githubOrg: 'contoso',
        teams: [
          {
            slug: 'engineering',
            name: 'Engineering',
            kind: 'organizational-unit',
          },
        ],
        memberAssignments: [{team: 'engineering', login: 'maya'}],
        repositoryGrants: [
          {
            teamSlug: 'engineering',
            repository: 'contoso/api',
            role: 'write',
            basePermission: 'none',
            visibility: 'private',
          },
        ],
      },
    })

    expect(output).toContain('Exact proposed writes (3):')
    expect(output).toContain('    - maya -> engineering')
    expect(output.join('\n')).toContain(
      'identities and changes absent from this plan are not authorized',
    )
    expect(output.join('\n')).toContain('dry-run evidence and checkpoint remain available')
    expect(output.join('\n')).toContain('migration run-123')
    expect(migrationApprovalPrompt()).toBe('Approve exactly this migration plan?')
  })

  it('labels dry-run plan review without implying that approval is required', () => {
    const output = renderMigrationPlanContext({
      runId: 'run-123',
      reportPath: 'migration-report-run-123.md',
      plan: {
        githubOrg: 'contoso',
        teams: [],
        memberAssignments: [],
        repositoryGrants: [],
      },
    })

    expect(output[0]).toBe('Planned GitHub changes for contoso:')
    expect(output.join('\n')).toContain('No target writes are performed during this review.')
    expect(output.join('\n')).not.toContain('Approval required')
  })

  it('groups exact writes for compact scanning without hiding safety facts', () => {
    const output = renderMigrationApprovalContext({
      runId: 'run-compact',
      reportPath: 'migration-report-run-compact.md',
      presentationMode: 'compact',
      plan: {
        githubOrg: 'contoso',
        teams: [{slug: 'engineering', name: 'Engineering', kind: 'flat'}],
        memberAssignments: [{team: 'engineering', login: 'maya'}],
        repositoryGrants: [
          {
            teamSlug: 'engineering',
            repository: 'contoso/api',
            role: 'write',
            basePermission: 'none',
            visibility: 'private',
          },
        ],
      },
    })

    expect(output).toContain(
      'Compact detail: the same safety facts are grouped for faster scanning.',
    )
    expect(output).toContain('  Teams (1): engineering (Engineering)')
    expect(output).toContain('  Memberships (1): maya -> engineering')
    expect(output.join('\n')).toContain('contoso/api')
    expect(output.join('\n')).toContain('If declined: no target writes')
    expect(output.join('\n')).toContain('Durable record:')
  })
})
