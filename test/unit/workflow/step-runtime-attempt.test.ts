import {mkdtemp, rm} from 'node:fs/promises'
import path from 'node:path'
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Effect} from 'effect'
import type {ResolvedCredentials} from '../../../src/auth/manager.js'
import type {EffectMigrationOptions} from '../../../src/effect/migration/options.js'
import {BlockingElicitationFailure} from '../../../src/effect/errors.js'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import {maskUserPrincipalName} from '../../../src/utils/redaction.js'
import type {ApprovalRequest, FailureLogEntry} from '../../../src/types/index.js'
import type {MigrationWorkflowInput} from '../../../src/workflow/contracts.js'
import type {
  ElicitationRecord,
  EntraOperatorDescription,
} from '../../../src/workflow/elicitations.js'
import {executeMigration} from '../../../src/workflow/step-runtime.js'
import {checkpointState} from '../effect/migration/test-state.js'

// Hoisted doubles for the module boundaries `executeMigrationAttempt` reaches.
// `runEffectMigration` is the migration engine; `getToken` is the Entra token
// source consulted before the attempt; `validateCredentials` is the credential
// gate. The real `CheckpointManager`, `BlockingElicitationFailure`, and
// `describeEntraOperator` are kept intact so persistence and `instanceof`
// behaviour are exercised for real.
const mocks = vi.hoisted(() => ({
  runEffectMigration: vi.fn<(options: EffectMigrationOptions) => unknown>(),
  getToken: vi.fn<() => Promise<{token: string} | null>>(),
  validateCredentials: vi.fn<(credentials: unknown, adoOrg: string) => unknown>(),
}))

vi.mock('../../../src/effect/migration.js', () => ({
  runEffectMigration: mocks.runEffectMigration,
}))

vi.mock('../../../src/effect/layers.js', async () => {
  const {Effect: E, Layer: L} = await import('effect')
  const {AuthServiceTag} = await import('../../../src/effect/services.js')
  const credentials = {
    entraScopes: ['https://graph.microsoft.com/.default'],
    entraCredential: {getToken: mocks.getToken},
  } as unknown as ResolvedCredentials
  return {
    AuthLiveLayer: L.succeed(AuthServiceTag, {resolveCredentials: E.succeed(credentials)}),
    validateCredentialsEffect: mocks.validateCredentials,
    makeAdoLayer: () => L.empty,
    makeGitHubLayer: () => L.empty,
    makeEntraLayer: () => L.empty,
    makeWorkflowApprovalLayer: () => L.empty,
    makeCheckpointLayer: () => L.empty,
    ReportWriterLiveLayer: L.empty,
  }
})

const ENV_KEYS = [
  'WORKFLOW_SQLITE_PATH',
  'WORKFLOW_REPORT_DIR',
  'WORKFLOW_APPLY_BATCH_MAX_UNITS',
  'WORKFLOW_APPLY_BATCH_DEADLINE_MS',
  'WORKFLOW_LEASE_MS',
  'WORKFLOW_LEASE_ACQUIRE_TIMEOUT_MS',
] as const

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
const scratchDirs: string[] = []
let currentToken: {token: string} | null = null

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  currentToken = null
  mocks.runEffectMigration.mockReset()
  mocks.getToken.mockReset()
  mocks.getToken.mockImplementation(async () => currentToken)
  mocks.validateCredentials.mockReset()
  mocks.validateCredentials.mockImplementation(() => Effect.void)
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, {recursive: true, force: true})))
})

async function useDatabase(): Promise<{dbPath: string; manager: CheckpointManager}> {
  const dir = await mkdtemp(path.join(process.cwd(), 'wf-attempt-'))
  scratchDirs.push(dir)
  const dbPath = path.join(dir, 'workflow.db')
  process.env.WORKFLOW_SQLITE_PATH = dbPath
  return {dbPath, manager: new CheckpointManager(dbPath)}
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

function blockingRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    action: 'Resolve healing for platform',
    context: {},
    displayLines: [],
    autoApprovable: false,
    elicitation: {
      kind: 'healing',
      operation: 'createTeam',
      target: 'platform',
      targetType: 'team',
      failureMode: 'TEAM_NAME_CONFLICT',
      actionOnApprove: 'retry',
    },
    ...overrides,
  }
}

function failure(overrides: Partial<FailureLogEntry> = {}): FailureLogEntry {
  return {
    failureMode: 'TEAM_NAME_CONFLICT',
    error: 'A team with that name already exists.',
    healingAction: 'await-operator',
    target: 'platform',
    resolved: false,
    ...overrides,
  }
}

function jwtOf(value: unknown): string {
  return `header.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}.signature`
}

function jwtRawPayload(raw: string): string {
  return `header.${Buffer.from(raw, 'utf8').toString('base64url')}.signature`
}

function failBlocking(request: ApprovalRequest = blockingRequest()): void {
  // Mirrors how the real engine signals a block: `Effect.fail`, not a synchronous throw
  // (see `makeWorkflowApprovalLayer` in `src/effect/layers.ts`). This distinction is load-bearing
  // — a synchronous throw was caught by the old try/catch, while a failed Effect surfaces through
  // the Exit's Cause, and only the latter is what production actually produces.
  mocks.runEffectMigration.mockReturnValue(Effect.fail(new BlockingElicitationFailure({request})))
}

function succeed(pendingWork: boolean): void {
  mocks.runEffectMigration.mockReturnValue(
    Effect.succeed({reportPath: 'ignored', runId: 'ignored', pendingApproval: false, pendingWork}),
  )
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject')
    },
    (error: unknown) => error,
  )
}

async function runElicitation(token: string | null): Promise<ElicitationRecord> {
  const {manager} = await useDatabase()
  await manager.save(checkpointState({runId: 'run-1', phase: 'create-teams', failureLog: []}))
  failBlocking()
  currentToken = token === null ? null : {token}
  const result = await executeMigration(workflowInput({workflowRunId: 'wf-1'}), false)
  if (result.status !== 'needs-elicitation') {
    throw new Error(`expected needs-elicitation, received ${result.status}`)
  }
  return result.elicitation
}

describe('executeMigration attempt — success and continuation', () => {
  it('reports completed when the migration engine has no pending work', async () => {
    await useDatabase()
    const output = path.join(scratchDirs[scratchDirs.length - 1] ?? '.', 'report.md')
    succeed(false)
    const result = await executeMigration(workflowInput({output}), false)
    expect(result).toEqual({runId: 'run-1', reportPath: output, status: 'completed'})
  })

  it('reports in-progress when the migration engine returns pending work', async () => {
    await useDatabase()
    const output = path.join(scratchDirs[scratchDirs.length - 1] ?? '.', 'report.md')
    succeed(true)
    const result = await executeMigration(workflowInput({output}), false)
    expect(result).toEqual({runId: 'run-1', reportPath: output, status: 'in-progress'})
  })

  it('rethrows a non-elicitation failure unchanged', async () => {
    await useDatabase()
    const boom = new Error('sync migration boom')
    mocks.runEffectMigration.mockImplementation(() => {
      throw boom
    })
    const error = await rejectionOf(executeMigration(workflowInput(), false))
    expect(error).toBe(boom)
  })
})

describe('executeMigration attempt — blocking elicitation persistence', () => {
  it('persists an elicitation and returns needs-elicitation', async () => {
    const {manager} = await useDatabase()
    await manager.save(
      checkpointState({
        runId: 'run-1',
        phase: 'create-teams',
        failureLog: [failure(), failure()],
      }),
    )
    failBlocking()
    currentToken = {
      token: jwtOf({
        upn: 'ada@contoso.com',
        name: 'Ada Lovelace',
        tid: 'tenant-1',
        oid: 'object-1',
      }),
    }

    const result = await executeMigration(workflowInput({workflowRunId: 'wf-1'}), false)
    expect(result.status).toBe('needs-elicitation')
    if (result.status !== 'needs-elicitation') {
      throw new Error('unreachable')
    }
    const record = result.elicitation
    expect(record.runId).toBe('run-1')
    expect(record.workflowRunId).toBe('wf-1')
    expect(record.phase).toBe('create-teams')
    expect(record.kind).toBe('healing')
    expect(record.status).toBe('pending')
    expect(record.operation).toBe('createTeam')
    expect(record.target).toBe('platform')
    expect(record.targetType).toBe('team')
    expect(record.failureMode).toBe('TEAM_NAME_CONFLICT')
    expect(record.actionOnApprove).toBe('retry')
    expect(record.choices).toEqual(['retry', 'abort'])
    expect(record.summary).toBe('TEAM_NAME_CONFLICT while attempting createTeam for platform')
    expect(record.question).toBe('Resolve healing for platform')
    expect(record.id.startsWith('elicit-')).toBe(true)
    expect(record.hookToken).toBe(`migration-elicitation:${record.id}`)
    expect(record.operator).toEqual({
      principalType: 'user',
      displayName: 'Ada Lovelace',
      userPrincipalName: maskUserPrincipalName('ada@contoso.com'),
      tenantId: 'tenant-1',
      objectId: 'object-1',
    })
    expect(record.source).toEqual({
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
    })
    expect(record.targetConfiguration).toEqual({
      githubOrg: 'contoso',
      apply: false,
      concurrency: 4,
      prefix: '',
      suffix: '',
    })

    const persisted = await manager.getElicitation(record.id)
    expect(persisted).not.toBeNull()
    expect(persisted?.id).toBe(record.id)
    expect(await manager.listElicitations('run-1')).toHaveLength(1)
  })

  it('throws when a blocking elicitation lacks a durable workflow run ID', async () => {
    const {manager} = await useDatabase()
    await manager.save(checkpointState({runId: 'run-1', phase: 'create-teams'}))
    failBlocking()
    currentToken = {token: jwtOf({upn: 'op@contoso.com'})}
    const error = await rejectionOf(executeMigration(workflowInput(), false))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'Blocking elicitations require a durable workflow run ID.',
    )
  })

  it('throws when no checkpoint state exists for the run', async () => {
    await useDatabase()
    failBlocking()
    currentToken = {token: jwtOf({upn: 'op@contoso.com'})}
    const error = await rejectionOf(executeMigration(workflowInput({workflowRunId: 'wf-1'}), false))
    expect((error as Error).message).toBe(
      'Cannot persist a blocking elicitation for migration run-1.',
    )
  })

  it('throws when the blocking request carries no elicitation metadata', async () => {
    const {manager} = await useDatabase()
    await manager.save(checkpointState({runId: 'run-1', phase: 'map'}))
    failBlocking({
      action: 'no metadata',
      context: {},
      displayLines: [],
      autoApprovable: false,
    })
    currentToken = {token: jwtOf({upn: 'op@contoso.com'})}
    const error = await rejectionOf(executeMigration(workflowInput({workflowRunId: 'wf-1'}), false))
    expect((error as Error).message).toBe(
      'Cannot persist a blocking elicitation for migration run-1.',
    )
  })
})

const operatorCases: readonly {
  readonly label: string
  readonly token: string | null
  readonly expected: EntraOperatorDescription
}[] = [
  {
    label: 'a user from upn claims',
    token: jwtOf({upn: 'ada@contoso.com', name: 'Ada Lovelace', tid: 'tenant-1', oid: 'object-1'}),
    expected: {
      principalType: 'user',
      displayName: 'Ada Lovelace',
      userPrincipalName: maskUserPrincipalName('ada@contoso.com'),
      tenantId: 'tenant-1',
      objectId: 'object-1',
    },
  },
  {
    label: 'a user from preferred_username and sub claims',
    token: jwtOf({preferred_username: 'bob@contoso.com', sub: 'sub-1'}),
    expected: {
      principalType: 'user',
      userPrincipalName: maskUserPrincipalName('bob@contoso.com'),
      objectId: 'sub-1',
    },
  },
  {
    label: 'a service principal from idtyp and appid claims',
    token: jwtOf({idtyp: 'app', appid: 'client-1', tid: 'tenant-9'}),
    expected: {principalType: 'service-principal', tenantId: 'tenant-9', clientId: 'client-1'},
  },
  {
    label: 'a service principal from appid alone',
    token: jwtOf({appid: 'client-2', tid: 'tenant-2'}),
    expected: {principalType: 'service-principal', tenantId: 'tenant-2', clientId: 'client-2'},
  },
  {
    label: 'a service principal from azp alone',
    token: jwtOf({azp: 'client-3'}),
    expected: {principalType: 'service-principal', clientId: 'client-3'},
  },
  {
    label: 'a managed identity from xms_mirid',
    token: jwtOf({xms_mirid: '/subscriptions/s/mi', tid: 'tenant-3'}),
    expected: {principalType: 'managed-identity', tenantId: 'tenant-3'},
  },
  {
    label: 'unknown for an object without identity claims',
    token: jwtOf({foo: 'bar'}),
    expected: {principalType: 'unknown'},
  },
  {
    label: 'unknown for a token with fewer than two segments',
    token: 'nodots',
    expected: {principalType: 'unknown'},
  },
  {
    label: 'unknown for a token with an empty payload segment',
    token: 'header..signature',
    expected: {principalType: 'unknown'},
  },
  {
    label: 'unknown for an undecodable JSON payload',
    token: jwtRawPayload('not-json-{'),
    expected: {principalType: 'unknown'},
  },
  {
    label: 'unknown for an array payload',
    token: jwtOf([1, 2, 3]),
    expected: {principalType: 'unknown'},
  },
  {
    label: 'unknown for a scalar payload',
    token: jwtOf(42),
    expected: {principalType: 'unknown'},
  },
  {
    label: 'unknown for a null payload',
    token: jwtOf(null),
    expected: {principalType: 'unknown'},
  },
  {
    label: 'unknown when no entra token is issued',
    token: null,
    expected: {principalType: 'unknown'},
  },
]

describe('describeEntraOperator claim parsing', () => {
  it.each(operatorCases)('resolves $label', async (testCase) => {
    const record = await runElicitation(testCase.token)
    expect(record.operator).toEqual(testCase.expected)
  })
})

describe('apply-batch limits and positiveIntEnv', () => {
  const applyBatchCases: readonly {
    readonly label: string
    readonly env: Readonly<Record<string, string>>
    readonly expected: {maxUnits: number; softDeadlineMs: number}
  }[] = [
    {
      label: 'unset falls back to defaults',
      env: {},
      expected: {maxUnits: 250, softDeadlineMs: 480000},
    },
    {
      label: 'valid positive integers are used',
      env: {WORKFLOW_APPLY_BATCH_MAX_UNITS: '7', WORKFLOW_APPLY_BATCH_DEADLINE_MS: '120000'},
      expected: {maxUnits: 7, softDeadlineMs: 120000},
    },
    {
      label: 'zero falls back to defaults',
      env: {WORKFLOW_APPLY_BATCH_MAX_UNITS: '0'},
      expected: {maxUnits: 250, softDeadlineMs: 480000},
    },
    {
      label: 'negative values fall back to defaults',
      env: {WORKFLOW_APPLY_BATCH_MAX_UNITS: '-5'},
      expected: {maxUnits: 250, softDeadlineMs: 480000},
    },
    {
      label: 'non-numeric values fall back to defaults',
      env: {WORKFLOW_APPLY_BATCH_MAX_UNITS: 'abc'},
      expected: {maxUnits: 250, softDeadlineMs: 480000},
    },
  ]

  it.each(applyBatchCases)('applyBatch: $label', async (testCase) => {
    await useDatabase()
    for (const [key, value] of Object.entries(testCase.env)) {
      process.env[key] = value
    }
    succeed(false)
    await executeMigration(workflowInput({apply: true}), true)
    const options = mocks.runEffectMigration.mock.calls[0]?.[0]
    expect(options?.apply).toBe(true)
    expect(options?.applyBatch).toEqual(testCase.expected)
  })

  it('omits applyBatch and passes through options on a dry run', async () => {
    await useDatabase()
    process.env.WORKFLOW_LEASE_MS = '45000'
    process.env.WORKFLOW_LEASE_ACQUIRE_TIMEOUT_MS = '3000'
    succeed(false)
    const output = path.join(scratchDirs[scratchDirs.length - 1] ?? '.', 'report.md')
    await executeMigration(workflowInput({output, prefix: 'team-', suffix: '-prod'}), false)
    const options = mocks.runEffectMigration.mock.calls[0]?.[0]
    expect(options?.apply).toBe(false)
    expect(options?.applyBatch).toBeUndefined()
    expect(options?.runId).toBe('run-1')
    expect(options?.concurrency).toBe(4)
    expect(options?.preserveCheckpoint).toBe(true)
    expect(options?.output).toBe(output)
    expect(options?.prefix).toBe('team-')
    expect(options?.suffix).toBe('-prod')
  })

  it('clamps concurrency to a minimum of one', async () => {
    await useDatabase()
    succeed(false)
    await executeMigration(workflowInput({concurrency: 0}), false)
    const options = mocks.runEffectMigration.mock.calls[0]?.[0]
    expect(options?.concurrency).toBe(1)
  })
})

describe('resolveReportPath', () => {
  it('honours an explicit output path', async () => {
    await useDatabase()
    succeed(false)
    const output = path.join(scratchDirs[scratchDirs.length - 1] ?? '.', 'explicit-report.md')
    const result = await executeMigration(workflowInput({output}), false)
    expect(result.reportPath).toBe(output)
  })

  it('derives the report path from WORKFLOW_REPORT_DIR when no output is given', async () => {
    await useDatabase()
    const reportDir = scratchDirs[scratchDirs.length - 1] ?? '.'
    process.env.WORKFLOW_REPORT_DIR = reportDir
    succeed(false)
    const result = await executeMigration(workflowInput(), false)
    expect(result.reportPath).toBe(path.resolve(reportDir, 'migration-report-run-1.md'))
  })

  it('falls back to the current working directory', async () => {
    await useDatabase()
    succeed(false)
    const result = await executeMigration(workflowInput(), false)
    expect(result.reportPath).toBe(path.resolve(process.cwd(), 'migration-report-run-1.md'))
  })
})

describe('executeMigration — lease contention', () => {
  it('returns an in-progress continuation when the apply lease is held by another worker', async () => {
    const {manager} = await useDatabase()
    process.env.WORKFLOW_LEASE_ACQUIRE_TIMEOUT_MS = '1'
    const held = await manager.acquireMigrationLease(
      'run-1:apply',
      'other-owner',
      new Date().toISOString(),
      new Date(Date.now() + 600_000).toISOString(),
    )
    expect(held).toBe(true)
    const output = path.join(scratchDirs[scratchDirs.length - 1] ?? '.', 'report.md')

    const result = await executeMigration(workflowInput({apply: true, output}), true)
    expect(result).toEqual({runId: 'run-1', reportPath: output, status: 'in-progress'})
    expect(mocks.runEffectMigration).not.toHaveBeenCalled()
  })

  it('raises a retriable error when the prepare lease is held by another worker', async () => {
    const {manager} = await useDatabase()
    process.env.WORKFLOW_LEASE_ACQUIRE_TIMEOUT_MS = '1'
    await manager.acquireMigrationLease(
      'run-1:prepare',
      'other-owner',
      new Date().toISOString(),
      new Date(Date.now() + 600_000).toISOString(),
    )

    const error = await rejectionOf(executeMigration(workflowInput(), false))
    expect((error as Error).message).toContain('is held by another worker')
    expect(mocks.runEffectMigration).not.toHaveBeenCalled()
  })
})

describe('regression — a typed Effect failure must reach the elicitation branch', () => {
  it('persists an elicitation when the engine fails the Effect rather than throwing', async () => {
    const {manager} = await useDatabase()
    await manager.save(
      checkpointState({runId: 'run-1', phase: 'create-teams', failureLog: [failure()]}),
    )
    // This is how the real engine signals a block: `Effect.fail(new BlockingElicitationFailure)`
    // (see `layers.ts`). `Effect.runPromise` rejects with an opaque FiberFailure that WRAPS the
    // typed failure, so the old `catch (error) { error instanceof BlockingElicitationFailure }`
    // guard was always false and this entire branch was dead in production — no elicitation was
    // ever persisted and the operator was never asked to resolve the block. The runtime now reads
    // the failure out of the Exit's Cause.
    mocks.runEffectMigration.mockReturnValue(
      Effect.fail(new BlockingElicitationFailure({request: blockingRequest()})),
    )
    currentToken = {token: jwtOf({upn: 'op@contoso.com'})}

    const result = await executeMigration(workflowInput({workflowRunId: 'wf-1'}), false)

    expect(result.status).toBe('needs-elicitation')
    expect(await manager.listElicitations('run-1')).toHaveLength(1)
  })

  it('still rethrows a non-elicitation typed failure', async () => {
    await useDatabase()
    mocks.runEffectMigration.mockReturnValue(Effect.fail(new Error('provider exploded')))

    const error = await rejectionOf(executeMigration(workflowInput({workflowRunId: 'wf-1'}), false))

    // Squashing the cause surfaces the real error instead of an opaque FiberFailure wrapper.
    expect((error as Error).message).toContain('provider exploded')
  })

  it('still rethrows an unchecked defect', async () => {
    await useDatabase()
    mocks.runEffectMigration.mockReturnValue(Effect.die(new Error('unrecoverable defect')))

    const error = await rejectionOf(executeMigration(workflowInput({workflowRunId: 'wf-1'}), false))

    expect((error as Error).message).toContain('unrecoverable defect')
  })
})
