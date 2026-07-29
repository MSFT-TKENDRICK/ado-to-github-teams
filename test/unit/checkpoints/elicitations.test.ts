import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import {TransientFailure} from '../../../src/effect/errors.js'
import {appendFailure} from '../../../src/effect/migration/state.js'
import {CHECKPOINT_SCHEMA_VERSION, type CheckpointState} from '../../../src/types/index.js'
import {toElicitationRecord} from '../../../src/workflow/elicitations.js'

function checkpoint(runId: string): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: `hash-${runId}`,
    runId,
    timestamp: '2026-07-29T12:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    migrationConfig: {
      apply: true,
      prefix: '',
      suffix: '',
      concurrency: 4,
    },
    phase: 'create-teams',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [
      {
        failureMode: 'TransientFailure',
        error: 'HTTP 503',
        healingAction: 'Escalated',
        target: 'core',
        resolved: false,
      },
    ],
    approvalHistory: [],
  }
}

function elicitation(
  runId: string,
  workflowRunId: string,
  occurrence = 1,
  actionOnApprove: 'retry' | 'skip' = 'skip',
) {
  return toElicitationRecord({
    runId,
    workflowRunId,
    phase: 'create-teams',
    occurrence,
    request: {
      action: 'Skip failed create-team after operator review',
      context: {target: 'core'},
      displayLines: ['Provider returned HTTP 503'],
      autoApprovable: false,
      elicitation: {
        kind: 'healing',
        operation: 'create-team',
        target: 'core',
        targetType: 'team',
        failureMode: 'TransientFailure',
        actionOnApprove,
        trace: {
          agentSessionId: 'sdk-session',
          sdkProvided: true,
          agentMessageId: 'sdk-message',
          localCorrelationId: 'local-correlation',
          conversationHistory: [
            {
              role: 'user',
              content: 'authorization=do-not-persist-this-secret',
            },
          ],
        },
      },
    },
    operator: {
      principalType: 'user',
      userPrincipalName: 'operator@contoso.com',
    },
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
    createdAt: '2026-07-29T12:01:00.000Z',
  })
}

async function manager(): Promise<CheckpointManager> {
  const directory = await mkdtemp(path.join(tmpdir(), 'elicitations-'))
  return new CheckpointManager(path.join(directory, 'workflow.db'))
}

describe('durable parallel elicitations', () => {
  it('deduplicates retries and isolates resolution between parallel sessions', async () => {
    const store = await manager()
    for (const runId of ['run-a', 'run-b']) {
      await store.save(checkpoint(runId))
      await store.linkWorkflow({
        migrationRunId: runId,
        workflowRunId: `workflow-${runId}`,
        createdAt: '2026-07-29T12:00:00.000Z',
      })
    }
    const first = elicitation('run-a', 'workflow-run-a')
    await store.createElicitation(first)
    const replayed = elicitation('run-a', 'workflow-run-a', 2)
    expect(replayed.id).not.toBe(first.id)
    const reused = await store.createElicitation({
      ...replayed,
      trace: {
        agentSessionId: 'retry-session',
        sdkProvided: false,
        localCorrelationId: 'retry-correlation',
        conversationHistory: [],
      },
    })
    expect(reused.id).toBe(first.id)
    await store.createElicitation(elicitation('run-b', 'workflow-run-b'))

    expect(await store.listElicitations('run-a', 'pending')).toHaveLength(1)
    expect((await store.getElicitation(first.id))?.operator.userPrincipalName).toBe(
      'o***@contoso.com',
    )
    expect((await store.getElicitation(first.id))?.trace?.conversationHistory[0]?.content).toBe(
      '[REDACTED]',
    )
    expect(await store.listWorkflowSessions(true)).toHaveLength(2)

    await store.resolveElicitation(first.id, {
      action: 'skip',
      decidedBy: 'operator@contoso.com',
    })

    const blocked = await store.listWorkflowSessions(true)
    expect(blocked.map((session) => session.runId)).toEqual(['run-b'])
    expect((await store.load('run-a'))?.skippedItems).toEqual([
      {
        type: 'team',
        name: 'core',
        reason: 'TransientFailure while attempting create-team for core',
      },
    ])
    expect((await store.load('run-a'))?.failureLog).toEqual([
      expect.objectContaining({
        target: 'core',
        failureMode: 'TransientFailure',
        userApproved: true,
        resolved: true,
      }),
    ])
    expect(await store.listPendingResumptions()).toHaveLength(1)
  })

  it('serializes conflicting parallel decisions and keeps the winner immutable', async () => {
    const store = await manager()
    await store.save(checkpoint('run-a'))
    await store.linkWorkflow({
      migrationRunId: 'run-a',
      workflowRunId: 'workflow-run-a',
      createdAt: '2026-07-29T12:00:00.000Z',
    })
    const pending = elicitation('run-a', 'workflow-run-a')
    await store.createElicitation(pending)

    const results = await Promise.allSettled([
      store.resolveElicitation(pending.id, {
        action: 'skip',
        decidedBy: 'operator-a',
      }),
      store.resolveElicitation(pending.id, {
        action: 'abort',
        decidedBy: 'operator-b',
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await store.getElicitation(pending.id))?.decision).toBeDefined()
  })

  it('creates a new blocker when a retried operation fails again', async () => {
    const store = await manager()
    const initial = checkpoint('run-a')
    await store.save(initial)
    await store.linkWorkflow({
      migrationRunId: 'run-a',
      workflowRunId: 'workflow-run-a',
      createdAt: '2026-07-29T12:00:00.000Z',
    })
    const first = elicitation('run-a', 'workflow-run-a', 1, 'retry')
    await store.createElicitation(first)
    await store.resolveElicitation(first.id, {
      action: 'retry',
      decidedBy: 'operator',
    })
    await expect(store.createElicitation(first)).rejects.toThrow(
      'collides with an already resolved occurrence',
    )

    const resumed = await store.load('run-a')
    expect(resumed).not.toBeNull()
    const failedAgain = appendFailure(
      resumed!,
      new TransientFailure({
        service: 'github',
        status: 503,
        message: 'HTTP 503 after retry',
      }),
      'Recorded team create failure',
      'core',
    )
    await store.save(failedAgain)
    const occurrence = failedAgain.failureLog.filter(
      (entry) => entry.target === 'core' && entry.failureTag === 'TransientFailure',
    ).length
    const second = elicitation('run-a', 'workflow-run-a', occurrence)
    expect(second.id).not.toBe(first.id)

    await expect(store.createElicitation(second)).resolves.toMatchObject({
      id: second.id,
      status: 'pending',
    })
    expect(await store.listElicitations('run-a', 'pending')).toEqual([
      expect.objectContaining({id: second.id}),
    ])
  })

  it('leases hook resumption once and never downgrades a terminal workflow', async () => {
    const store = await manager()
    await store.save(checkpoint('run-a'))
    await store.linkWorkflow({
      migrationRunId: 'run-a',
      workflowRunId: 'workflow-run-a',
      createdAt: '2026-07-29T12:00:00.000Z',
    })
    const pending = elicitation('run-a', 'workflow-run-a')
    await store.createElicitation(pending)
    await store.resolveElicitation(pending.id, {
      action: 'abort',
      decidedBy: 'operator',
    })

    const claims = await Promise.all([
      store.claimElicitationResume(
        pending.id,
        'owner-a',
        '2026-07-29T12:02:00.000Z',
        '2026-07-29T12:01:00.000Z',
      ),
      store.claimElicitationResume(
        pending.id,
        'owner-b',
        '2026-07-29T12:02:00.000Z',
        '2026-07-29T12:01:00.000Z',
      ),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const owner = claims[0] ? 'owner-a' : 'owner-b'

    await store.recordWorkflowOutcome('run-a', 'escalated', 'migration-escalation.md', 'escalation')
    await store.markElicitationResumed(pending.id, owner, '2026-07-29T12:03:00.000Z')

    expect((await store.listWorkflowSessions())[0]).toMatchObject({
      workflowStatus: 'escalated',
      reportKind: 'escalation',
    })
  })
})
