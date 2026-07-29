import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {CHECKPOINT_SCHEMA_VERSION} from '../../../src/checkpoints/configuration.js'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import {persistApproval} from '../../../src/workflow/step-runtime.js'
import type {CheckpointState} from '../../../src/types/index.js'

function checkpoint(): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: 'configuration-hash',
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    migrationConfig: {
      apply: false,
      prefix: '',
      suffix: '',
    },
    phase: 'dry-run',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
    teamPlan: [
      {
        team: {
          slug: 'engineering',
          name: 'Engineering',
          privacy: 'closed',
        },
        kind: 'organizational-unit',
        sourceAdoTeamIds: [],
      },
      {
        team: {
          slug: 'api-contributors',
          name: 'API Contributors',
          privacy: 'closed',
        },
        kind: 'repository',
        parentSlug: 'engineering',
        sourceAdoTeamIds: ['ado-api'],
      },
    ],
    repositoryGrants: [
      {
        repository: 'contoso/api',
        teamSlug: 'api-contributors',
        role: 'write',
        basePermission: 'none',
        visibility: 'private',
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('durable approval persistence', () => {
  it('is idempotent for an identical decision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-approval-'))
    const database = path.join(directory, 'workflow.db')
    vi.stubEnv('WORKFLOW_SQLITE_PATH', database)
    const manager = new CheckpointManager(database)
    await manager.save(checkpoint())

    const decision = {
      approved: true,
      approvedBy: 'operator@example.com',
      comment: 'Reviewed exact plan',
    }
    await persistApproval('run-1', decision)
    await persistApproval('run-1', decision)

    const state = await manager.load('run-1')
    expect(state?.approvalHistory).toHaveLength(1)
    const context = JSON.parse(state?.approvalHistory[0]?.context ?? '{}') as {
      teamPlan?: unknown[]
      repositoryGrants?: unknown[]
    }
    expect(context.teamPlan).toHaveLength(2)
    expect(context.repositoryGrants).toEqual([
      {
        teamSlug: 'api-contributors',
        repository: 'contoso/api',
        role: 'write',
        basePermission: 'none',
        visibility: 'private',
      },
    ])
  })

  it('rejects any mutation of a recorded decision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-approval-'))
    const database = path.join(directory, 'workflow.db')
    vi.stubEnv('WORKFLOW_SQLITE_PATH', database)
    const manager = new CheckpointManager(database)
    await manager.save(checkpoint())
    await persistApproval('run-1', {
      approved: true,
      approvedBy: 'operator@example.com',
      comment: 'Reviewed exact plan',
    })

    await expect(
      persistApproval('run-1', {
        approved: true,
        approvedBy: 'another-operator@example.com',
        comment: 'Reviewed exact plan',
      }),
    ).rejects.toThrow('immutable approval decision')
  })

  it('serializes concurrent decisions so only one can be recorded', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-approval-'))
    const database = path.join(directory, 'workflow.db')
    vi.stubEnv('WORKFLOW_SQLITE_PATH', database)
    const manager = new CheckpointManager(database)
    await manager.save(checkpoint())

    const results = await Promise.allSettled([
      persistApproval('run-1', {
        approved: true,
        approvedBy: 'operator-a@example.com',
      }),
      persistApproval('run-1', {
        approved: false,
        approvedBy: 'operator-b@example.com',
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    )
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
      1,
    )
    expect((await manager.load('run-1'))?.approvalHistory).toHaveLength(1)
  })
})
