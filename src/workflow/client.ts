import {Context, Data, Effect, Either, Layer, Schema} from 'effect'
import type {
  BlockingElicitation,
  MigrationTraceContext,
  PlannedTeam,
  RepositoryGrant,
} from '../types/index.js'
import type {
  ApprovalDecision,
  ElicitationDecision,
  MigrationTopologyInput,
} from './contracts.js'

export interface StartMigrationRequest {
  readonly runId: string
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly apply: boolean
  readonly concurrency: number
  readonly prefix?: string
  readonly suffix?: string
  readonly topology?: MigrationTopologyInput
  readonly entraActor?: import('../types/index.js').EntraActorDescription
}

export interface StartedMigration {
  readonly runId: string
  readonly workflowRunId: string
  readonly status: string
}

export interface MigrationPlan {
  readonly githubOrg: string
  readonly teams: ReadonlyArray<{
    readonly slug: string
    readonly name: string
    readonly parentSlug?: string | undefined
    readonly kind: PlannedTeam['kind']
  }>
  readonly memberAssignments: ReadonlyArray<{
    readonly team: string
    readonly login: string
  }>
  readonly repositoryGrants: ReadonlyArray<{
    readonly teamSlug: string
    readonly repository: string
    readonly role: RepositoryGrant['role']
    readonly basePermission: RepositoryGrant['basePermission']
    readonly visibility: RepositoryGrant['visibility']
  }>
}

export interface WorkerMigrationStatus {
  readonly workflowRunId: string
  readonly workflowStatus: string
  readonly migration: {
    readonly runId: string
    readonly phase: string
    readonly updatedAt: string
    readonly adoOrg: string
    readonly adoProject: string
    readonly githubOrg: string
    readonly apply: boolean
    readonly output?: string | undefined
    readonly concurrency: number
    readonly blocked: boolean
    readonly elicitations: ReadonlyArray<BlockingElicitation>
    readonly traceContext: MigrationTraceContext
    readonly plan: MigrationPlan
    readonly approvals: ReadonlyArray<{
      readonly action: string
      readonly approved: boolean
    }>
  } | null
}

export class WorkflowWorkerFailure extends Data.TaggedError(
  'WorkflowWorkerFailure',
)<{
  readonly message: string
  readonly status?: number
}> {}

export interface WorkflowWorkerService {
  readonly start: (
    request: StartMigrationRequest,
  ) => Effect.Effect<StartedMigration, WorkflowWorkerFailure>
  readonly status: (
    runId: string,
  ) => Effect.Effect<WorkerMigrationStatus, WorkflowWorkerFailure>
  readonly latest: Effect.Effect<WorkerMigrationStatus | null, WorkflowWorkerFailure>
  readonly sessions: Effect.Effect<
    ReadonlyArray<WorkerMigrationStatus>,
    WorkflowWorkerFailure
  >
  readonly approve: (
    runId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, WorkflowWorkerFailure>
  readonly report: (runId: string) => Effect.Effect<string, WorkflowWorkerFailure>
  readonly answerElicitation: (
    runId: string,
    decision: ElicitationDecision,
  ) => Effect.Effect<void, WorkflowWorkerFailure>
  readonly escalationReport: (
    runId: string,
    elicitationId: string,
  ) => Effect.Effect<string, WorkflowWorkerFailure>
}

export class WorkflowWorkerServiceTag extends Context.Tag(
  'WorkflowWorkerService',
)<WorkflowWorkerServiceTag, WorkflowWorkerService>() {}

const StartedMigrationSchema = Schema.Struct({
  runId: Schema.String,
  workflowRunId: Schema.String,
  status: Schema.String,
})

const WorkerMigrationStatusSchema = Schema.Struct({
  workflowRunId: Schema.String,
  workflowStatus: Schema.String,
  migration: Schema.NullOr(
    Schema.Struct({
      runId: Schema.String,
      phase: Schema.Literal(
        'fetch',
        'map',
        'dry-run',
        'create-teams',
        'assign-members',
        'grant-repositories',
        'report',
      ),
      updatedAt: Schema.String,
      adoOrg: Schema.String,
      adoProject: Schema.String,
      githubOrg: Schema.String,
      apply: Schema.Boolean,
      output: Schema.optional(Schema.String),
      concurrency: Schema.Number,
      blocked: Schema.Boolean,
      elicitations: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          runId: Schema.String,
          kind: Schema.Literal('apply-approval', 'healing-escalation'),
          status: Schema.Literal('pending', 'resolved', 'superseded'),
          phase: Schema.Literal(
            'fetch',
            'map',
            'dry-run',
            'create-teams',
            'assign-members',
            'grant-repositories',
            'report',
          ),
          summary: Schema.String,
          semanticSummary: Schema.String,
          proposedAction: Schema.String,
          allowedActions: Schema.Array(
            Schema.Literal('approve', 'reject', 'retry', 'skip', 'abort'),
          ),
          contextFingerprint: Schema.String,
          createdAt: Schema.String,
          traceId: Schema.String,
          agentSessionId: Schema.optional(Schema.String),
          threadId: Schema.optional(Schema.String),
          failure: Schema.optional(
            Schema.Struct({
              tag: Schema.String,
              service: Schema.String,
              message: Schema.String,
            }),
          ),
          workItems: Schema.Array(
            Schema.Struct({
              owner: Schema.Literal('agent', 'human'),
              description: Schema.String,
              estimatedEffort: Schema.String,
            }),
          ),
          reportPath: Schema.optional(Schema.String),
          answer: Schema.optional(
            Schema.Struct({
              answerId: Schema.String,
              action: Schema.Literal(
                'approve',
                'reject',
                'retry',
                'skip',
                'abort',
              ),
              answeredBy: Schema.String,
              answeredAt: Schema.String,
              resumeDeliveredAt: Schema.optional(Schema.String),
              comment: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
      traceContext: Schema.Struct({
        migrationSessionId: Schema.String,
        workflowRunId: Schema.optional(Schema.String),
        durableWorkloadTraceId: Schema.String,
      }),
      plan: Schema.Struct({
        githubOrg: Schema.String,
        teams: Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            name: Schema.String,
            parentSlug: Schema.optional(Schema.String),
            kind: Schema.Literal(
              'flat',
              'organizational-unit',
              'project',
              'repository',
            ),
          }),
        ),
        memberAssignments: Schema.Array(
          Schema.Struct({
            team: Schema.String,
            login: Schema.String,
          }),
        ),
        repositoryGrants: Schema.Array(
          Schema.Struct({
            teamSlug: Schema.String,
            repository: Schema.String,
            role: Schema.Literal('read', 'triage', 'write', 'maintain', 'admin'),
            basePermission: Schema.Literal(
              'none',
              'read',
              'triage',
              'write',
              'maintain',
              'admin',
            ),
            visibility: Schema.Literal('public', 'private', 'internal'),
          }),
        ),
      }),
      approvals: Schema.Array(
        Schema.Struct({
          action: Schema.String,
          context: Schema.String,
          approved: Schema.Boolean,
          timestamp: Schema.String,
        }),
      ),
    }),
  ),
})

function decode<A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  description: string,
): A {
  const decoded = Schema.decodeUnknownEither(schema)(value)
  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid ${description}: ${String(decoded.left)}`)
  }
  return decoded.right
}

function failure(error: unknown, status?: number): WorkflowWorkerFailure {
  return new WorkflowWorkerFailure({
    message: error instanceof Error ? error.message : String(error),
    ...(status === undefined ? {} : {status}),
  })
}

export function makeWorkflowWorkerLayer(
  baseUrl: string,
  apiToken: string,
): Layer.Layer<WorkflowWorkerServiceTag> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')

  const fetchWorker = (
    pathname: string,
    init?: RequestInit,
  ): Effect.Effect<Response, WorkflowWorkerFailure> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${normalizedBaseUrl}${pathname}`, {
          ...init,
          headers: {
            authorization: `Bearer ${apiToken}`,
            ...(init?.body ? {'content-type': 'application/json'} : {}),
            ...init?.headers,
          },
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
          throw failure(
            new Error(
              `Workflow worker returned HTTP ${response.status}: ${await response.text()}`,
            ),
            response.status,
          )
        }
        return response
      },
      catch: (error) =>
        error instanceof WorkflowWorkerFailure ? error : failure(error),
    })

  return Layer.succeed(WorkflowWorkerServiceTag, {
    start: (request) =>
      fetchWorker('/api/migrations', {
        method: 'POST',
        body: JSON.stringify(request),
      }).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: async () =>
              decode(
                StartedMigrationSchema,
                await response.json(),
                'migration start response',
              ),
            catch: failure,
          }),
        ),
      ),
    status: (runId) =>
      fetchWorker(`/api/migrations/${encodeURIComponent(runId)}`).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: async () =>
              decode(
                WorkerMigrationStatusSchema,
                await response.json(),
                'migration status response',
              ),
            catch: failure,
          }),
        ),
      ),
    latest: fetchWorker('/api/migrations/latest').pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: async () => {
            const value = (await response.json()) as unknown
            return value === null
              ? null
              : decode(
                  WorkerMigrationStatusSchema,
                  value,
                  'latest migration status response',
                )
          },
          catch: failure,
        }),
      ),
    ),
    sessions: fetchWorker('/api/migrations').pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: async () =>
            decode(
              Schema.Array(WorkerMigrationStatusSchema),
              await response.json(),
              'migration sessions response',
            ),
          catch: failure,
        }),
      ),
    ),
    approve: (runId, decision) =>
      fetchWorker(`/api/migrations/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        body: JSON.stringify(decision),
      }).pipe(Effect.asVoid),
    report: (runId) =>
      fetchWorker(`/api/migrations/${encodeURIComponent(runId)}/report`).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: async () => response.text(),
            catch: failure,
          }),
        ),
      ),
    answerElicitation: (runId, decision) =>
      fetchWorker(
        `/api/migrations/${encodeURIComponent(runId)}/elicitations/${encodeURIComponent(decision.elicitationId)}`,
        {
          method: 'POST',
          body: JSON.stringify(decision),
        },
      ).pipe(Effect.asVoid),
    escalationReport: (runId, elicitationId) =>
      fetchWorker(
        `/api/migrations/${encodeURIComponent(runId)}/elicitations/${encodeURIComponent(elicitationId)}/report`,
      ).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: async () => response.text(),
            catch: failure,
          }),
        ),
      ),
  })
}

export function waitForMigration(
  runId: string,
  ready: (status: WorkerMigrationStatus) => boolean,
  maximumAttempts = 3600,
): Effect.Effect<
  WorkerMigrationStatus,
  WorkflowWorkerFailure,
  WorkflowWorkerServiceTag
> {
  return Effect.gen(function* () {
    const worker = yield* WorkflowWorkerServiceTag
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const status = yield* worker.status(runId)
      if (ready(status)) {
        return status
      }
      if (['failed', 'cancelled'].includes(status.workflowStatus.toLowerCase())) {
        return yield* Effect.fail(
          new WorkflowWorkerFailure({
            message: `Workflow ${status.workflowRunId} ended with status ${status.workflowStatus}.`,
          }),
        )
      }
      yield* Effect.sleep('1 second')
    }
    return yield* Effect.fail(
      new WorkflowWorkerFailure({
        message: `Timed out waiting for migration ${runId}.`,
      }),
    )
  })
}
