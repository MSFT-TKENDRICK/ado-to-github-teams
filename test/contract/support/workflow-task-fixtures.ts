// Shared fixture data for the `durable-migration-worker-internal-api` Pact
// contract (the task-callback boundary the durable workflow engine calls back
// into `src/worker.ts` on: `/internal/migrations/:runId/{prepare,apply}`).
// Both the consumer test (`workflow-task-consumer.test.ts`) and the provider
// verification test (`workflow-task-provider.test.ts`) import these constants
// so the literal values recorded in the pact interactions and the values the
// real provider drives can never drift apart.
export const taskConsumerName = 'durable-migration-workflow'
export const taskProviderName = 'durable-migration-worker-internal-api'

export const runId = '22222222-2222-4222-8222-222222222222'
export const workflowRunId = 'workflow-run-task-1'

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
