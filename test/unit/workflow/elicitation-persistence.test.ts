import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import {
  persistThenResumeElicitation,
  type ElicitationRuntimeDependencies,
} from '../../../src/workflow/approval-runtime.js'
import {
  markElicitationResumeDelivered,
  persistElicitationDecision,
} from '../../../src/workflow/step-runtime.js'
import {registerApplyElicitation} from '../../../src/workflow/elicitations.js'
import {checkpointState} from '../effect/migration/test-state.js'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {recursive: true, force: true}),
    ),
  )
})

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'elicitation-answer-'))
  directories.push(directory)
  const database = path.join(directory, 'workflow.db')
  vi.stubEnv('WORKFLOW_SQLITE_PATH', database)
  const manager = new CheckpointManager(database)
  const state = registerApplyElicitation(
    checkpointState({phase: 'dry-run'}),
    '2026-07-29T14:00:00.000Z',
  )
  await manager.save(state)
  const elicitation = state.elicitations?.[0]
  if (!elicitation) {
    throw new Error('Expected apply elicitation fixture')
  }
  return {manager, elicitation}
}

describe('elicitation persistence', () => {
  it('persists before resuming and does not resume an idempotent redelivery', async () => {
    const {manager, elicitation} = await setup()
    const resumed: string[] = []
    const events: string[] = []
    const dependencies: ElicitationRuntimeDependencies = {
      persist: async (runId, decision) => {
        events.push('persist')
        return persistElicitationDecision(runId, decision)
      },
      resume: async () => {
        events.push('resume')
        resumed.push('resume')
      },
      markDelivered: async (runId, elicitationId, answerId) => {
        events.push('delivered')
        await markElicitationResumeDelivered(runId, elicitationId, answerId)
      },
    }
    const decision = {
      elicitationId: elicitation.id,
      expectedFingerprint: elicitation.contextFingerprint,
      answerId: 'answer-1',
      action: 'approve' as const,
      answeredBy: 'operator',
    }

    await persistThenResumeElicitation(
      'run-1',
      'migration-approval:run-1',
      decision,
      dependencies,
    )
    await persistThenResumeElicitation(
      'run-1',
      'migration-approval:run-1',
      decision,
      dependencies,
    )

    const state = await manager.load('run-1')
    expect(state?.elicitations?.[0]?.status).toBe('resolved')
    expect(state?.approvalHistory).toHaveLength(1)
    expect(resumed).toEqual(['resume'])
    expect(events).toEqual(['persist', 'resume', 'delivered', 'persist'])
  })

  it('retries workflow resumption when the answer committed but delivery failed', async () => {
    const {manager, elicitation} = await setup()
    let attempts = 0
    const dependencies: ElicitationRuntimeDependencies = {
      persist: persistElicitationDecision,
      resume: async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('temporary resume failure')
        }
      },
      markDelivered: markElicitationResumeDelivered,
    }
    const decision = {
      elicitationId: elicitation.id,
      expectedFingerprint: elicitation.contextFingerprint,
      answerId: 'answer-retry',
      action: 'approve' as const,
      answeredBy: 'operator',
    }

    await expect(
      persistThenResumeElicitation(
        'run-1',
        'migration-approval:run-1',
        decision,
        dependencies,
      ),
    ).rejects.toThrow('temporary resume failure')
    await persistThenResumeElicitation(
      'run-1',
      'migration-approval:run-1',
      decision,
      dependencies,
    )

    expect(attempts).toBe(2)
    expect(
      (await manager.load('run-1'))?.elicitations?.[0]?.answer
        ?.resumeDeliveredAt,
    ).toBeDefined()
  })

  it('serializes competing answers so exactly one wins', async () => {
    const {manager, elicitation} = await setup()
    const base = {
      elicitationId: elicitation.id,
      expectedFingerprint: elicitation.contextFingerprint,
    }
    const outcomes = await Promise.allSettled([
      persistElicitationDecision('run-1', {
        ...base,
        answerId: 'answer-a',
        action: 'approve',
        answeredBy: 'operator-a',
      }),
      persistElicitationDecision('run-1', {
        ...base,
        answerId: 'answer-b',
        action: 'reject',
        answeredBy: 'operator-b',
      }),
    ])

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1)
    expect((await manager.load('run-1'))?.approvalHistory).toHaveLength(1)
  })

  it('rejects an answer captured against a stale fingerprint', async () => {
    const {manager, elicitation} = await setup()
    await expect(
      persistElicitationDecision('run-1', {
        elicitationId: elicitation.id,
        expectedFingerprint: 'stale-fingerprint',
        answerId: 'answer-stale',
        action: 'approve',
        answeredBy: 'operator',
      }),
    ).rejects.toThrow('refresh the session inbox')
    expect((await manager.load('run-1'))?.approvalHistory).toHaveLength(0)
  })
})
