import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {Cause, Effect, Exit, Option} from 'effect'
import {afterEach, describe, expect, it} from 'vitest'
import {
  makeWorkflowWorkerLayer,
  waitForMigration,
  WorkflowWorkerFailure,
  WorkflowWorkerServiceTag,
  type WorkerMigrationStatus,
  type WorkflowWorkerService,
} from '../../../src/workflow/client.js'
import {exportMigrationPlan} from '../../../src/plans/artifact.js'
import type {MigrationPlanArtifact} from '../../../src/plans/types.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointState,
  type MappingResult,
} from '../../../src/types/index.js'

interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string
  readonly contentType: string
  readonly body: string
}

interface WorkerResponse {
  readonly status: number
  readonly body: string
  readonly contentType?: string
}

interface WorkerServer {
  readonly url: string
  readonly requests: () => readonly CapturedRequest[]
  readonly close: () => Promise<void>
}

type Responder = (request: CapturedRequest) => WorkerResponse

async function startWorkerServer(responder: Responder): Promise<WorkerServer> {
  const captured: CapturedRequest[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization ?? '',
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      }
      captured.push(entry)
      const result = responder(entry)
      response.writeHead(result.status, {
        'content-type': result.contentType ?? 'application/json',
      })
      response.end(result.body)
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => [...captured],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function runWorker<A>(
  baseUrl: string,
  use: (service: WorkflowWorkerService) => Effect.Effect<A, WorkflowWorkerFailure>,
): Promise<Exit.Exit<A, WorkflowWorkerFailure>> {
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      return yield* use(worker)
    }).pipe(Effect.provide(makeWorkflowWorkerLayer(baseUrl, 'api-token'))),
  )
}

function expectSuccess<A>(exit: Exit.Exit<A, WorkflowWorkerFailure>): A {
  if (Exit.isFailure(exit)) {
    throw new Error(`expected success but failed: ${Cause.pretty(exit.cause)}`)
  }
  return exit.value
}

function expectFailure<A>(exit: Exit.Exit<A, WorkflowWorkerFailure>): WorkflowWorkerFailure {
  if (Exit.isSuccess(exit)) {
    throw new Error('expected a typed failure but the effect succeeded')
  }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    throw new Error(`expected a typed failure, got: ${Cause.pretty(exit.cause)}`)
  }
  return failure.value
}

const validElicitation = {
  id: 'elicit-1',
  runId: 'run-1',
  workflowRunId: 'wf-1',
  hookToken: 'migration-elicitation:elicit-1',
  phase: 'create-teams',
  kind: 'healing',
  status: 'pending',
  summary: 'TransientFailure while attempting create-team for core',
  question: 'Skip failed create-team after operator review',
  choices: ['skip', 'abort'],
  operation: 'create-team',
  target: 'core',
  targetType: 'team',
  failureMode: 'TransientFailure',
  actionOnApprove: 'skip',
  createdAt: '2026-01-01T00:01:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  operator: {principalType: 'user'},
  source: {adoOrg: 'https://dev.azure.com/contoso', adoProject: 'Platform'},
  targetConfiguration: {githubOrg: 'contoso', apply: true, concurrency: 4, prefix: '', suffix: ''},
}

function migrationObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-1',
    phase: 'apply',
    updatedAt: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    apply: true,
    concurrency: 4,
    plan: {githubOrg: 'contoso', teams: [], memberAssignments: [], repositoryGrants: []},
    approvals: [
      {
        action: 'Apply migration',
        context: '{}',
        approved: true,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ],
    blockingElicitations: [],
    ...overrides,
  }
}

function statusBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workflowRunId: 'wf-1',
    workflowStatus: 'running',
    migration: migrationObject(),
    ...overrides,
  })
}

function mapping(): MappingResult {
  return {
    adoTeam: {id: 'team-1', name: 'Platform', projectId: 'project-1', projectName: 'Engineering'},
    githubTeam: {slug: 'platform', name: 'Platform', privacy: 'closed'},
    memberMappings: [
      {
        adoIdentity: {
          id: 'user-1',
          displayName: 'Ada Lovelace',
          uniqueName: 'ada@contoso.com',
          isContainer: false,
        },
        githubUser: {login: 'ada', type: 'User'},
        mapped: true,
      },
    ],
    edgeCases: [],
  }
}

function checkpoint(): CheckpointState {
  const teamMapping = mapping()
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: 'a'.repeat(64),
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Engineering',
    githubOrg: 'contoso',
    migrationConfig: {apply: false, prefix: '', suffix: '', topologyDigest: '', allowAdmin: false},
    phase: 'dry-run',
    completedTeams: [],
    completedMemberPairs: [],
    completedRepositoryGrants: [],
    pendingTeams: [teamMapping.adoTeam],
    mappings: [teamMapping],
    teamPlan: [
      {team: teamMapping.githubTeam, kind: 'flat', sourceAdoTeamIds: [teamMapping.adoTeam.id]},
    ],
    repositoryGrants: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

async function exportedArtifact(): Promise<MigrationPlanArtifact> {
  return Effect.runPromise(exportMigrationPlan(checkpoint()))
}

let server: WorkerServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('makeWorkflowWorkerLayer', () => {
  it('starts a migration, normalizing a trailing-slash base URL and sending the bearer token', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: JSON.stringify({runId: 'run-1', workflowRunId: 'wf-1', status: 'accepted'}),
    }))

    const exit = await runWorker(`${server.url}/`, (worker) =>
      worker.start({
        runId: 'run-1',
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: true,
        concurrency: 4,
      }),
    )

    expect(expectSuccess(exit)).toEqual({runId: 'run-1', workflowRunId: 'wf-1', status: 'accepted'})
    const [request] = server.requests()
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/api/migrations')
    expect(request?.authorization).toBe('Bearer api-token')
    expect(request?.contentType).toBe('application/json')
    const sent: unknown = JSON.parse(request?.body ?? '{}')
    expect(sent).toMatchObject({runId: 'run-1', apply: true, concurrency: 4})
  })

  it('decodes a full migration status including a blocking elicitation', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: statusBody({migration: migrationObject({blockingElicitations: [validElicitation]})}),
    }))

    const status = expectSuccess(await runWorker(server.url, (worker) => worker.status('run-1')))

    expect(status.workflowRunId).toBe('wf-1')
    expect(status.migration?.runId).toBe('run-1')
    expect(status.migration?.blockingElicitations[0]?.id).toBe('elicit-1')
    expect(server.requests()[0]?.url).toBe('/api/migrations/run-1')
  })

  it('returns null from latest when the worker has no migration yet', async () => {
    server = await startWorkerServer(() => ({status: 200, body: 'null'}))

    const latest = expectSuccess(await runWorker(server.url, (worker) => worker.latest))

    expect(latest).toBeNull()
    expect(server.requests()[0]?.url).toBe('/api/migrations/latest')
  })

  it('decodes a non-null latest migration status', async () => {
    server = await startWorkerServer(() => ({status: 200, body: statusBody()}))

    const latest = expectSuccess(await runWorker(server.url, (worker) => worker.latest))

    expect(latest?.workflowRunId).toBe('wf-1')
  })

  it('lists sessions with the blocking and limit query parameters', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: JSON.stringify([
        {
          runId: 'run-1',
          workflowRunId: 'wf-1',
          workflowStatus: 'blocked',
          phase: 'create-teams',
          updatedAt: '2026-01-01T00:02:00.000Z',
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'contoso',
          blockingElicitations: [validElicitation],
          reportKind: 'migration',
        },
      ]),
    }))

    const sessions = expectSuccess(await runWorker(server.url, (worker) => worker.list(true, 25)))

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.runId).toBe('run-1')
    expect(sessions[0]?.blockingElicitations[0]?.target).toBe('core')
    expect(server.requests()[0]?.url).toBe('/api/migrations?blocking=true&limit=25')
  })

  it('defaults the list query to blocking=false and limit=100', async () => {
    server = await startWorkerServer(() => ({status: 200, body: '[]'}))

    expectSuccess(await runWorker(server.url, (worker) => worker.list()))

    expect(server.requests()[0]?.url).toBe('/api/migrations?blocking=false&limit=100')
  })

  it('posts an approval decision and resolves to void', async () => {
    server = await startWorkerServer(() => ({status: 200, body: '{}'}))

    const exit = await runWorker(server.url, (worker) =>
      worker.approve('run-1', {approved: true, approvedBy: 'operator@example.com'}),
    )

    expect(expectSuccess(exit)).toBeUndefined()
    const [request] = server.requests()
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/api/migrations/run-1/approval')
    const sent: unknown = JSON.parse(request?.body ?? '{}')
    expect(sent).toMatchObject({approved: true, approvedBy: 'operator@example.com'})
  })

  it('reads the migration report as text', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: '# Migration report',
      contentType: 'text/markdown',
    }))

    const report = expectSuccess(await runWorker(server.url, (worker) => worker.report('run-1')))

    expect(report).toBe('# Migration report')
    expect(server.requests()[0]?.url).toBe('/api/migrations/run-1/report')
  })

  it('reads the escalation report as text', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: 'escalation body',
      contentType: 'text/markdown',
    }))

    const report = expectSuccess(
      await runWorker(server.url, (worker) => worker.escalationReport('run-1')),
    )

    expect(report).toBe('escalation body')
    expect(server.requests()[0]?.url).toBe('/api/migrations/run-1/escalation-report')
  })

  it('resolves an elicitation, percent-encoding the elicitation id', async () => {
    server = await startWorkerServer(() => ({status: 200, body: '{}'}))

    const exit = await runWorker(server.url, (worker) =>
      worker.resolveElicitation('run-1', 'elicit/1', {action: 'skip', decidedBy: 'operator'}),
    )

    expect(expectSuccess(exit)).toBeUndefined()
    const [request] = server.requests()
    expect(request?.url).toBe('/api/migrations/run-1/elicitations/elicit%2F1')
    const sent: unknown = JSON.parse(request?.body ?? '{}')
    expect(sent).toMatchObject({action: 'skip', decidedBy: 'operator'})
  })

  it('decodes and validates a well-formed plan artifact', async () => {
    const artifact = await exportedArtifact()
    server = await startWorkerServer(() => ({status: 200, body: JSON.stringify(artifact)}))

    const result = expectSuccess(
      await runWorker(server.url, (worker) => worker.planArtifact('run-1')),
    )

    expect(result.planHash).toBe(artifact.planHash)
    expect(result.operations).toHaveLength(artifact.operations.length)
    expect(server.requests()[0]?.url).toBe('/api/migrations/run-1/plan-artifact')
  })

  it('fails when the plan artifact payload cannot be decoded', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: JSON.stringify({unexpected: 'field'}),
    }))

    const failure = expectFailure(
      await runWorker(server.url, (worker) => worker.planArtifact('run-1')),
    )

    expect(failure._tag).toBe('WorkflowWorkerFailure')
    expect(failure.status).toBeUndefined()
  })

  it('fails when the plan artifact is structurally valid but its hash does not verify', async () => {
    const artifact = await exportedArtifact()
    const tampered = {...artifact, planHash: 'b'.repeat(64)}
    server = await startWorkerServer(() => ({status: 200, body: JSON.stringify(tampered)}))

    const failure = expectFailure(
      await runWorker(server.url, (worker) => worker.planArtifact('run-1')),
    )

    expect(failure._tag).toBe('WorkflowWorkerFailure')
    expect(failure.message).toContain('Plan hash does not match')
  })

  it('surfaces a non-2xx worker response as a failure carrying the HTTP status', async () => {
    server = await startWorkerServer(() => ({status: 500, body: 'boom'}))

    const failure = expectFailure(await runWorker(server.url, (worker) => worker.report('run-1')))

    expect(failure._tag).toBe('WorkflowWorkerFailure')
    expect(failure.status).toBe(500)
    expect(failure.message).toContain('HTTP 500')
  })

  it('surfaces a transport failure as a bounded failure without an HTTP status', async () => {
    const closed = await startWorkerServer(() => ({status: 200, body: '{}'}))
    const deadUrl = closed.url
    await closed.close()

    const failure = expectFailure(await runWorker(deadUrl, (worker) => worker.status('run-1')))

    expect(failure._tag).toBe('WorkflowWorkerFailure')
    expect(failure.status).toBeUndefined()
  })
})

describe('waitForMigration', () => {
  function poll(
    baseUrl: string,
    ready: (status: WorkerMigrationStatus) => boolean,
    maximumAttempts: number,
    onStatus?: (status: WorkerMigrationStatus) => void,
  ): Promise<Exit.Exit<WorkerMigrationStatus, WorkflowWorkerFailure>> {
    return Effect.runPromiseExit(
      waitForMigration('run-1', ready, maximumAttempts, onStatus).pipe(
        Effect.provide(makeWorkflowWorkerLayer(baseUrl, 'api-token')),
      ),
    )
  }

  it('returns the first status that satisfies the ready predicate and reports each poll', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: statusBody({migration: migrationObject({phase: 'completed'})}),
    }))
    const observed: string[] = []

    const status = expectSuccess(
      await poll(
        server.url,
        (state) => state.migration?.phase === 'completed',
        3600,
        (state) => observed.push(state.migration?.phase ?? ''),
      ),
    )

    expect(status.migration?.phase).toBe('completed')
    expect(observed).toEqual(['completed'])
  })

  it('returns as soon as the workflow reports a blocked status', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: statusBody({workflowStatus: 'blocked'}),
    }))

    const status = expectSuccess(await poll(server.url, () => false, 3600))

    expect(status.workflowStatus).toBe('blocked')
  })

  it('returns when a blocking elicitation is present even if the status is still running', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: statusBody({migration: migrationObject({blockingElicitations: [validElicitation]})}),
    }))

    const status = expectSuccess(await poll(server.url, () => false, 3600))

    expect(status.migration?.blockingElicitations).toHaveLength(1)
  })

  it('fails when the workflow ends in a terminal failed status', async () => {
    server = await startWorkerServer(() => ({
      status: 200,
      body: statusBody({workflowStatus: 'failed'}),
    }))

    const failure = expectFailure(await poll(server.url, () => false, 3600))

    expect(failure.message).toContain('ended with status failed')
  })

  it('fails with a timeout once the attempt budget is exhausted', async () => {
    server = await startWorkerServer(() => ({status: 200, body: statusBody()}))

    const failure = expectFailure(await poll(server.url, () => false, 1))

    expect(failure.message).toContain('Timed out waiting for migration')
  })
})
