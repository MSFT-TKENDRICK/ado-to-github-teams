import {beforeEach, describe, expect, it, vi} from 'vitest'

import type {
  ApprovalDecision,
  MigrationTaskResult,
  MigrationWorkflowInput,
} from '../../../src/workflow/contracts.js'
import type {ElicitationDecision, ElicitationRecord} from '../../../src/workflow/elicitations.js'

/**
 * Coverage for the durable migration workflow orchestration.
 *
 * `migrationWorkflow` is the top-level control flow of a destructive migration: it decides whether
 * a plan is applied at all, whether an operator's rejection stops the run, how a bounded apply
 * batch resumes, and whether a blocking elicitation escalates or retries. Every branch here has an
 * operational consequence, and none of them were covered — the module sat at 2.1% lines and 0%
 * functions because it only ever ran inside the durable worker.
 *
 * It is testable in isolation once its two boundaries are mocked: the `workflow` SDK (durable
 * metadata plus the hook primitive that suspends on an operator decision) and the three task
 * steps. Everything between those boundaries is this repository's own logic.
 */

const WORKFLOW_RUN_ID = 'wf-run-1'

/** Hook values are queued per hook type, so a single run can answer several suspensions. */
const hookQueue = new Map<string, unknown[]>()
/** Tokens of every hook the workflow opened, in order — used to assert correlation. */
const openedHooks: Array<{token: string; type: string}> = []
/** Tokens of every hook the workflow disposed, proving `using` released each suspension. */
const disposedHooks: string[] = []

function queueHookValue(type: string, value: unknown): void {
  const existing = hookQueue.get(type) ?? []
  existing.push(value)
  hookQueue.set(type, existing)
}

function takeHookValue(type: string): unknown {
  const queued = hookQueue.get(type)
  if (!queued || queued.length === 0) {
    throw new Error(`No queued hook value for type "${type}".`)
  }
  return queued.shift()
}

vi.mock('workflow', () => ({
  getWorkflowMetadata: () => ({workflowRunId: WORKFLOW_RUN_ID}),
  createHook: (options: {token: string; metadata: {type: string}}) => {
    openedHooks.push({token: options.token, type: options.metadata.type})
    const value = takeHookValue(options.metadata.type)
    // The workflow both `await`s the hook and releases it via `using`, so the double must be a
    // thenable that is also disposable.
    return {
      then: (resolve: (settled: unknown) => unknown) => resolve(value),
      [Symbol.dispose]: () => {
        disposedHooks.push(options.token)
      },
    }
  },
}))

const prepareMigrationStep = vi.fn<(input: MigrationWorkflowInput, runId: string) => unknown>()
const applyMigrationStep = vi.fn<(input: MigrationWorkflowInput, runId: string) => unknown>()
const generateEscalationReportStep =
  vi.fn<(input: MigrationWorkflowInput, runId: string, elicitationId: string) => unknown>()

vi.mock('../../../src/workflow/steps.js', () => ({
  prepareMigrationStep: (input: MigrationWorkflowInput, runId: string) =>
    prepareMigrationStep(input, runId),
  applyMigrationStep: (input: MigrationWorkflowInput, runId: string) =>
    applyMigrationStep(input, runId),
  generateEscalationReportStep: (
    input: MigrationWorkflowInput,
    runId: string,
    elicitationId: string,
  ) => generateEscalationReportStep(input, runId, elicitationId),
}))

const {migrationWorkflow} = await import('../../../src/workflow/migration.js')
const {approvalToken} = await import('../../../src/workflow/contracts.js')

const REPORT_PATH = '/reports/migration-report-run-1.md'

function input(overrides: Partial<MigrationWorkflowInput> = {}): MigrationWorkflowInput {
  return {
    runId: 'run-1',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Engineering',
    githubOrg: 'contoso',
    apply: false,
    concurrency: 1,
    workerBaseUrl: 'http://127.0.0.1:7331',
    taskTokens: {prepare: 'prepare-token', apply: 'apply-token', escalation: 'escalation-token'},
    ...overrides,
  }
}

function completed(): MigrationTaskResult {
  return {runId: 'run-1', reportPath: REPORT_PATH, status: 'completed'}
}

function inProgress(): MigrationTaskResult {
  return {runId: 'run-1', reportPath: REPORT_PATH, status: 'in-progress'}
}

/**
 * Only `id` and `hookToken` are read by the workflow, so the record is narrowed to those rather
 * than fabricating twenty unrelated fields that no assertion would ever look at.
 */
function blocked(id = 'elicitation-1'): MigrationTaskResult {
  const elicitation = {
    id,
    hookToken: `migration-elicitation:${id}`,
  } as unknown as ElicitationRecord
  return {runId: 'run-1', reportPath: REPORT_PATH, status: 'needs-elicitation', elicitation}
}

function approval(approved: boolean): ApprovalDecision {
  return {approved, approvedBy: 'operator@contoso.com'}
}

function elicitationDecision(action: ElicitationDecision['action']): ElicitationDecision {
  return {action, decidedBy: 'operator@contoso.com'}
}

beforeEach(() => {
  hookQueue.clear()
  openedHooks.length = 0
  disposedHooks.length = 0
  prepareMigrationStep.mockReset()
  applyMigrationStep.mockReset()
  generateEscalationReportStep.mockReset()
})

describe('migrationWorkflow planning', () => {
  it('returns a planned result and never applies when apply is false', async () => {
    prepareMigrationStep.mockResolvedValue(completed())

    const result = await migrationWorkflow(input({apply: false}))

    expect(result).toEqual({runId: 'run-1', reportPath: REPORT_PATH, status: 'planned'})
    expect(prepareMigrationStep).toHaveBeenCalledTimes(1)
    // Dry-run is the default and it must not reach the apply path, nor ask for approval.
    expect(applyMigrationStep).not.toHaveBeenCalled()
    expect(openedHooks).toEqual([])
  })

  it('passes the durable workflow run id into the prepare step', async () => {
    prepareMigrationStep.mockResolvedValue(completed())

    await migrationWorkflow(input())

    expect(prepareMigrationStep).toHaveBeenCalledWith(expect.anything(), WORKFLOW_RUN_ID)
  })

  it.each(['in-progress', 'needs-elicitation'] as const)(
    'refuses to continue when planning returns %s',
    async (status) => {
      prepareMigrationStep.mockResolvedValue(status === 'in-progress' ? inProgress() : blocked())

      await expect(migrationWorkflow(input({apply: true}))).rejects.toThrow(
        'Migration planning unexpectedly requested an elicitation.',
      )
      expect(applyMigrationStep).not.toHaveBeenCalled()
    },
  )
})

describe('migrationWorkflow approval gate', () => {
  it('stops at rejected without performing any write', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(false))

    const result = await migrationWorkflow(input({apply: true}))

    expect(result).toEqual({runId: 'run-1', reportPath: REPORT_PATH, status: 'rejected'})
    // The approval gate is the last point before destructive writes; a rejection must mean the
    // apply step is never invoked at all.
    expect(applyMigrationStep).not.toHaveBeenCalled()
  })

  it('opens the approval hook on the run-correlated token and releases it', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(false))

    await migrationWorkflow(input({apply: true, runId: 'run-1'}))

    expect(openedHooks).toEqual([{token: approvalToken('run-1'), type: 'migration-approval'}])
    expect(disposedHooks).toEqual([approvalToken('run-1')])
  })

  it('applies once approved', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(true))
    applyMigrationStep.mockResolvedValue(completed())

    const result = await migrationWorkflow(input({apply: true}))

    expect(result).toEqual({runId: 'run-1', reportPath: REPORT_PATH, status: 'completed'})
    expect(applyMigrationStep).toHaveBeenCalledTimes(1)
  })
})

describe('migrationWorkflow bounded apply batching', () => {
  it('resumes an in-progress apply without asking for approval again', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(true))
    applyMigrationStep
      .mockResolvedValueOnce(inProgress())
      .mockResolvedValueOnce(inProgress())
      .mockResolvedValueOnce(completed())

    const result = await migrationWorkflow(input({apply: true}))

    expect(result.status).toBe('completed')
    // A bounded apply slice returns a continuation; the workflow must drive it to completion
    // itself rather than re-prompting the operator for each batch.
    expect(applyMigrationStep).toHaveBeenCalledTimes(3)
    expect(openedHooks.filter((hook) => hook.type === 'migration-approval')).toHaveLength(1)
  })
})

describe('migrationWorkflow elicitation handling', () => {
  it('escalates and stops when the operator aborts', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(true))
    applyMigrationStep.mockResolvedValueOnce(blocked('elicitation-7'))
    queueHookValue('migration-elicitation', elicitationDecision('abort'))
    generateEscalationReportStep.mockResolvedValue({
      runId: 'run-1',
      reportPath: '/reports/migration-escalation-run-1.md',
    })

    const result = await migrationWorkflow(input({apply: true}))

    expect(result).toEqual({
      runId: 'run-1',
      reportPath: '/reports/migration-escalation-run-1.md',
      status: 'escalated',
    })
    expect(generateEscalationReportStep).toHaveBeenCalledWith(
      expect.anything(),
      WORKFLOW_RUN_ID,
      'elicitation-7',
    )
    // An abort must not retry the failing unit.
    expect(applyMigrationStep).toHaveBeenCalledTimes(1)
  })

  it.each(['retry', 'skip'] as const)(
    'continues applying after the operator chooses %s',
    async (action) => {
      prepareMigrationStep.mockResolvedValue(completed())
      queueHookValue('migration-approval', approval(true))
      applyMigrationStep.mockResolvedValueOnce(blocked()).mockResolvedValueOnce(completed())
      queueHookValue('migration-elicitation', elicitationDecision(action))

      const result = await migrationWorkflow(input({apply: true}))

      expect(result.status).toBe('completed')
      expect(applyMigrationStep).toHaveBeenCalledTimes(2)
      expect(generateEscalationReportStep).not.toHaveBeenCalled()
    },
  )

  it('opens the elicitation hook on the record token and releases every hook', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(true))
    applyMigrationStep
      .mockResolvedValueOnce(blocked('elicitation-9'))
      .mockResolvedValueOnce(completed())
    queueHookValue('migration-elicitation', elicitationDecision('retry'))

    await migrationWorkflow(input({apply: true, runId: 'run-1'}))

    expect(openedHooks).toEqual([
      {token: approvalToken('run-1'), type: 'migration-approval'},
      {token: 'migration-elicitation:elicitation-9', type: 'migration-elicitation'},
    ])
    // `using` must release both suspensions, otherwise a resumed run leaks durable hooks.
    expect(disposedHooks).toEqual(['migration-elicitation:elicitation-9', approvalToken('run-1')])
  })

  it('handles several sequential elicitations in one apply phase', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(true))
    applyMigrationStep
      .mockResolvedValueOnce(blocked('elicitation-1'))
      .mockResolvedValueOnce(blocked('elicitation-2'))
      .mockResolvedValueOnce(completed())
    queueHookValue('migration-elicitation', elicitationDecision('retry'))
    queueHookValue('migration-elicitation', elicitationDecision('skip'))

    const result = await migrationWorkflow(input({apply: true}))

    expect(result.status).toBe('completed')
    expect(applyMigrationStep).toHaveBeenCalledTimes(3)
    expect(openedHooks.filter((hook) => hook.type === 'migration-elicitation')).toHaveLength(2)
  })

  it('interleaves continuation batches with elicitations', async () => {
    prepareMigrationStep.mockResolvedValue(completed())
    queueHookValue('migration-approval', approval(true))
    applyMigrationStep
      .mockResolvedValueOnce(inProgress())
      .mockResolvedValueOnce(blocked('elicitation-3'))
      .mockResolvedValueOnce(inProgress())
      .mockResolvedValueOnce(completed())
    queueHookValue('migration-elicitation', elicitationDecision('retry'))

    const result = await migrationWorkflow(input({apply: true}))

    expect(result.status).toBe('completed')
    expect(applyMigrationStep).toHaveBeenCalledTimes(4)
  })
})
