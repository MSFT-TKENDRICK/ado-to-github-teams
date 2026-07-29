import {describe, expect, it} from 'vitest'
import {
  renderSessionInbox,
  sessionInboxRows,
} from '../../../src/commands/sessions.js'
import type {WorkerMigrationStatus} from '../../../src/workflow/client.js'
import {registerApplyElicitation} from '../../../src/workflow/elicitations.js'
import {checkpointState} from '../effect/migration/test-state.js'

function workerStatus(
  runId: string,
  blocked: boolean,
): WorkerMigrationStatus {
  const state = blocked
    ? registerApplyElicitation(
        checkpointState({runId, phase: 'dry-run'}),
        '2026-07-29T14:00:00.000Z',
      )
    : checkpointState({runId, phase: 'map'})
  return {
    workflowRunId: `workflow-${runId}`,
    workflowStatus: 'running',
    migration: {
      runId,
      phase: state.phase,
      updatedAt: state.timestamp,
      adoOrg: state.adoOrg,
      adoProject: state.adoProject,
      githubOrg: state.githubOrg,
      apply: state.migrationConfig.apply,
      concurrency: state.migrationConfig.concurrency ?? 1,
      blocked,
      elicitations: state.elicitations ?? [],
      traceContext: state.traceContext ?? {
        migrationSessionId: runId,
        durableWorkloadTraceId: `migration:${runId}`,
      },
      plan: {
        githubOrg: state.githubOrg,
        teams: [],
        memberAssignments: [],
        repositoryGrants: [],
      },
      approvals: [],
    },
  }
}

describe('session inbox UX', () => {
  it('filters blocked sessions and renders switchable identifiers', () => {
    const rows = sessionInboxRows(
      [workerStatus('run-blocked', true), workerStatus('run-running', false)],
      true,
    )
    const rendered = renderSessionInbox(rows)

    expect(rows.map((row) => row.runId)).toEqual(['run-blocked'])
    expect(rendered).toContain('RUN ID')
    expect(rendered).toContain('run-blocked')
    expect(rendered).toContain('BLOCKED')
    expect(rendered).toContain('apply-run-blocked:apply-approval')
  })
})
