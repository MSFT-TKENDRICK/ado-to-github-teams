import {mkdtemp, rm} from 'node:fs/promises'
import path from 'node:path'
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import type {ApprovalDecision, MigrationWorkflowInput} from '../../../src/workflow/contracts.js'
import {
  executeMigration,
  linkWorkflowRun,
  persistApproval,
} from '../../../src/workflow/step-runtime.js'

const scratchDirs: string[] = []

async function scratchDatabase(): Promise<string> {
  const directory = await mkdtemp(path.join(process.cwd(), 'wf-runtime-'))
  scratchDirs.push(directory)
  return path.join(directory, 'workflow.db')
}

async function useDatabase(): Promise<{dbPath: string; manager: CheckpointManager}> {
  const dbPath = await scratchDatabase()
  vi.stubEnv('WORKFLOW_SQLITE_PATH', dbPath)
  return {dbPath, manager: new CheckpointManager(dbPath)}
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the operation to reject but it resolved')
    },
    (error: unknown) => error,
  )
}

function workflowInput(overrides: Partial<MigrationWorkflowInput> = {}): MigrationWorkflowInput {
  return {
    runId: 'run-1',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    apply: false,
    concurrency: 4,
    workerBaseUrl: 'http://127.0.0.1:9',
    taskTokens: {prepare: 'prepare-token', apply: 'apply-token', escalation: 'escalation-token'},
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await Promise.all(scratchDirs.map((directory) => rm(directory, {recursive: true, force: true})))
})

describe('executeMigration', () => {
  it('rejects a structurally invalid workflow input before touching the database', async () => {
    await useDatabase()

    await expect(
      executeMigration({runId: 'run-1'} as unknown as MigrationWorkflowInput, false),
    ).rejects.toThrow('Invalid migration workflow input')
  })

  it('raises a retriable lease error when prepare cannot claim a contended lease', async () => {
    const {manager} = await useDatabase()
    vi.stubEnv('WORKFLOW_LEASE_ACQUIRE_TIMEOUT_MS', '1')
    const now = new Date().toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    expect(await manager.acquireMigrationLease('run-1:prepare', 'other-worker', now, future)).toBe(
      true,
    )

    const error = await rejectionOf(executeMigration(workflowInput({apply: false}), false))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('is held by another worker')
    expect((error as {retriable?: boolean}).retriable).toBe(true)
  })

  it('returns an in-progress continuation when apply cannot claim a contended lease', async () => {
    const {manager, dbPath} = await useDatabase()
    vi.stubEnv('WORKFLOW_LEASE_ACQUIRE_TIMEOUT_MS', '1')
    const now = new Date().toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    expect(await manager.acquireMigrationLease('run-1:apply', 'other-worker', now, future)).toBe(
      true,
    )
    const reportPath = path.join(path.dirname(dbPath), 'report.md')

    const result = await executeMigration(workflowInput({apply: true, output: reportPath}), true)

    expect(result).toEqual({runId: 'run-1', reportPath, status: 'in-progress'})
  })
})

describe('persistApproval', () => {
  it('rejects an invalid approval payload before opening the checkpoint store', async () => {
    await useDatabase()

    await expect(
      persistApproval('run-1', {approved: 'yes', approvedBy: 'op'} as unknown as ApprovalDecision),
    ).rejects.toThrow('Invalid migration approval payload')
  })

  it('fails when recording an approval for a migration with no checkpoint', async () => {
    await useDatabase()

    await expect(persistApproval('run-404', {approved: true, approvedBy: 'op'})).rejects.toThrow(
      'Cannot record approval for missing migration run-404',
    )
  })
})

describe('linkWorkflowRun', () => {
  it('links a migration run to a workflow run and exposes it', async () => {
    const {manager} = await useDatabase()

    await linkWorkflowRun('mig-1', 'wf-1')

    expect(await manager.getWorkflowRunId('mig-1')).toBe('wf-1')
  })

  it('is idempotent when linking the same workflow run twice', async () => {
    const {manager} = await useDatabase()

    await linkWorkflowRun('mig-1', 'wf-1')
    await linkWorkflowRun('mig-1', 'wf-1')

    expect(await manager.getWorkflowRunId('mig-1')).toBe('wf-1')
  })

  it('rejects linking a migration run to a different workflow run', async () => {
    await useDatabase()

    await linkWorkflowRun('mig-1', 'wf-1')

    await expect(linkWorkflowRun('mig-1', 'wf-2')).rejects.toThrow('already linked')
  })
})
