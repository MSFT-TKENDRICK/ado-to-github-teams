// Shared fixture data for the `durable-migration-worker-internal-api` Pact
// contract (the task-callback boundary the durable workflow engine calls back
// into `src/worker.ts` on: `/internal/migrations/:runId/{prepare,apply,escalation}`).
// Both the consumer test (`workflow-task-consumer.test.ts`) and the provider
// verification test (`workflow-task-provider.test.ts`) import these constants
// so the literal values recorded in the pact interactions and the values the
// real provider drives can never drift apart.
import type {CheckpointState} from '../../../src/types/index.js'
import {CHECKPOINT_SCHEMA_VERSION} from '../../../src/types/index.js'
import type {ElicitationRecord} from '../../../src/workflow/elicitations.js'

export const taskConsumerName = 'durable-migration-workflow'
export const taskProviderName = 'durable-migration-worker-internal-api'

export const runId = '22222222-2222-4222-8222-222222222222'
export const workflowRunId = 'workflow-run-task-1'
export const elicitationId = 'elicit-33333333333333333333333333333333'

// Not real credentials: fixture values shaped like the `taskTokens` field the
// wire schema requires (`MigrationWorkflowInputSchema.taskTokens`).
// This field is opaque request-body payload, not what authenticates the call —
// authentication is the `Authorization: Bearer <hmac>` header, computed from
// `WORKFLOW_TASK_SECRET` via `createTaskToken()` (see workflow-task-pact.ts and
// workflow-task-provider.test.ts's requestFilter). The pact interactions never
// assert the header's literal value; they use a regex matcher instead.
export const taskTokens = {
  prepare: 'test-task-token-fixture-prepare',
  apply: 'test-task-token-fixture-apply',
  escalation: 'test-task-token-fixture-escalation',
} as const

export const reportPath = `/data/reports/migration-report-${runId}.md`

// Unlike `reportPath` above (which the mocked `executeMigration` echoes back
// verbatim from the request's `output` field), the escalation endpoint's real
// (unmocked) handler always computes its own path under the app's temp report
// directory, so its literal value can never be asserted exactly by a Pact
// interaction recorded outside that process. This fixture value is only used
// as the *example* passed to `MatchersV3.like(...)` (a shape/type match, not
// an exact-value match) - see `addEscalationInteraction` in workflow-task-pact.ts.
export const escalationReportPathExample = `/data/reports/migration-escalation-${runId}-${elicitationId}.md`

export function workflowInput(workerBaseUrl: string) {
  return {
    runId,
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    apply: true,
    concurrency: 4,
    workerBaseUrl,
    taskTokens,
    workflowRunId,
    output: reportPath,
  } as const
}

/**
 * Checkpoint state the escalation provider state seeds before the real
 * `/internal/migrations/:runId/escalation` handler runs - that handler loads
 * this via `checkpointManager.load(runId)` to render the escalation dossier.
 */
export function escalationCheckpoint(): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: `hash-${runId}`,
    runId,
    timestamp: '2026-01-01T00:00:00.000Z',
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
    repositoryGrants: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

/**
 * The pending elicitation the escalation provider state seeds via
 * `checkpointManager.createElicitation(...)` so the real handler's
 * `checkpointManager.getElicitation(elicitationId)` lookup succeeds.
 */
export function escalationElicitation(): ElicitationRecord {
  return {
    id: elicitationId,
    runId,
    workflowRunId,
    hookToken: `migration-elicitation:${elicitationId}`,
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
  }
}
