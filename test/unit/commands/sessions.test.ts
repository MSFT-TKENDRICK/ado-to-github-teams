import {describe, expect, it} from 'vitest'
import {
  renderSessionInbox,
  sessionInboxRows,
} from '../../../src/commands/sessions.js'
import type {
  ElicitationRecord,
  MigrationSessionSummary,
} from '../../../src/workflow/elicitations.js'

function elicitation(): ElicitationRecord {
  return {
    id: 'elicit-1',
    runId: 'run-blocked',
    workflowRunId: 'workflow-1',
    hookToken: 'migration-elicitation:elicit-1',
    phase: 'assign-members',
    kind: 'healing',
    status: 'pending',
    summary: 'Rate limit while assigning a member',
    question: 'Retry the member assignment?',
    choices: ['retry', 'abort'],
    operation: 'assign member',
    target: 'core/ada',
    targetType: 'member',
    failureMode: 'RateLimitFailure',
    actionOnApprove: 'retry',
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    operator: {principalType: 'user', displayName: 'operator'},
    source: {
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
    },
    targetConfiguration: {
      githubOrg: 'contoso',
      apply: true,
      concurrency: 4,
      prefix: '',
      suffix: '',
    },
  }
}

function session(
  runId: string,
  blockingElicitations: readonly ElicitationRecord[],
): MigrationSessionSummary {
  return {
    runId,
    workflowRunId: `workflow-${runId}`,
    workflowStatus: blockingElicitations.length > 0 ? 'running' : 'completed',
    phase: blockingElicitations.length > 0 ? 'assign-members' : 'report',
    updatedAt: '2026-07-29T10:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    blockingElicitations,
  }
}

describe('sessions command rendering', () => {
  it('filters and identifies blocked sessions and their elicitations', () => {
    const rows = sessionInboxRows(
      [session('run-complete', []), session('run-blocked', [elicitation()])],
      true,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.runId).toBe('run-blocked')
    expect(rows[0]?.blocked).toBe(1)
    expect(renderSessionInbox(rows)).toContain('elicit-1:healing')
  })
})
