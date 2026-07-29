import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {CheckpointManager} from '../../src/checkpoints/manager.js'
import {CHECKPOINT_SCHEMA_VERSION, type CheckpointState} from '../../src/types/index.js'
import {toElicitationRecord} from '../../src/workflow/elicitations.js'

function state(runId: string, sequence: number): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: `hash-${runId}`,
    runId,
    timestamp: `2026-07-29T12:${String(sequence).padStart(2, '0')}:00.000Z`,
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: `Project-${sequence}`,
    githubOrg: 'contoso',
    migrationConfig: {
      apply: true,
      prefix: '',
      suffix: '',
      concurrency: 4,
    },
    phase: 'assign-members',
    completedTeams: ['core'],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [
      {
        failureMode: 'TransientFailure',
        error: `HTTP 503 for user-${sequence}`,
        healingAction: 'Escalated',
        target: `core:user-${sequence}`,
        resolved: false,
      },
    ],
    approvalHistory: [],
  }
}

function blocked(runId: string, sequence: number) {
  return toElicitationRecord({
    runId,
    workflowRunId: `workflow-${runId}`,
    phase: 'assign-members',
    occurrence: 1,
    request: {
      action: 'Skip failed member assignment after operator review',
      context: {target: `core:user-${sequence}`},
      displayLines: ['HTTP 503'],
      autoApprovable: false,
      elicitation: {
        kind: 'healing',
        operation: 'assign-member',
        target: `core:user-${sequence}`,
        targetType: 'member',
        failureMode: 'TransientFailure',
        actionOnApprove: 'skip',
      },
    },
    operator: {principalType: 'managed-identity', objectId: 'managed-object'},
    source: {
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: `Project-${sequence}`,
    },
    targetConfiguration: {
      githubOrg: 'contoso',
      apply: true,
      concurrency: 4,
      prefix: '',
      suffix: '',
    },
    createdAt: `2026-07-29T13:${String(sequence).padStart(2, '0')}:00.000Z`,
  })
}

describe('parallel elicitation persistence', () => {
  it('keeps concurrent migration blockers isolated while other sessions resolve', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'parallel-elicitations-'))
    const manager = new CheckpointManager(path.join(directory, 'workflow.db'))
    await manager.listCheckpoints()
    const runs = Array.from({length: 12}, (_, index) => ({
      runId: `run-${String(index).padStart(2, '0')}`,
      sequence: index,
    }))

    await Promise.all(
      runs.map(async ({runId, sequence}) => {
        await manager.save(state(runId, sequence))
        await manager.linkWorkflow({
          migrationRunId: runId,
          workflowRunId: `workflow-${runId}`,
          createdAt: '2026-07-29T12:00:00.000Z',
        })
        await manager.createElicitation(blocked(runId, sequence))
      }),
    )

    const initiallyBlocked = await manager.listWorkflowSessions(true, 100)
    expect(initiallyBlocked).toHaveLength(12)

    await Promise.all(
      initiallyBlocked
        .filter((_session, index) => index % 2 === 0)
        .map((session) =>
          manager.resolveElicitation(session.blockingElicitations[0]!.id, {
            action: 'skip',
            decidedBy: 'parallel-operator',
          }),
        ),
    )

    const remaining = await manager.listWorkflowSessions(true, 100)
    expect(remaining).toHaveLength(6)
    expect(
      remaining.every(
        (session) =>
          session.blockingElicitations.length === 1 && session.workflowStatus === 'blocked',
      ),
    ).toBe(true)
    expect(await manager.listPendingResumptions()).toHaveLength(6)
  })
})
