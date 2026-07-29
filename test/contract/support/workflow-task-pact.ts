// Interaction definitions for the `durable-migration-worker-internal-api`
// Pact contract, shared between the consumer test
// (workflow-task-consumer.test.ts) and the provider verification test
// (workflow-task-provider.test.ts). This boundary is the task-callback API
// the durable workflow engine's own step functions call back into
// `src/worker.ts` on (`/internal/migrations/:runId/{prepare,apply,escalation}`)
// — a first-party boundary distinct from the operator-facing
// `/api/migrations` boundary covered by workflow-worker-pact.ts.
import {
  elicitationId,
  escalationElicitation,
  escalationReportPathExample,
  reportPath,
  runId,
  taskTokens,
  workflowInput,
} from './workflow-task-fixtures.js'

type PactV3Type = typeof import('@pact-foundation/pact').PactV3
type MatchersV3Type = typeof import('@pact-foundation/pact').MatchersV3

export const workflowTaskProviderStates = {
  prepareReady: `migration ${runId} can execute its prepare (dry-run) task`,
  applyReady: `migration ${runId} can execute its apply task`,
  applyInProgress: `migration ${runId} apply has bounded batch work still pending`,
  applyBlocked: `migration ${runId} apply is blocked on elicitation ${elicitationId}`,
  escalationReady: `migration ${runId} has a pending elicitation ${elicitationId} to escalate`,
} as const

function authorizationMatcher(matchers: MatchersV3Type, token: string) {
  const value = ['Bearer', token].join(' ')
  return matchers.regex(/^Bearer\s.{16,}$/, value)
}

/**
 * The request body both interactions share: an exact `MigrationWorkflowInput`
 * except for `workerBaseUrl`, which is the mock/real server's own dynamic
 * base URL and is therefore matched by shape rather than by literal value.
 */
function requestBody(matchers: MatchersV3Type) {
  return {
    ...workflowInput(''),
    workerBaseUrl: matchers.like('http://worker.invalid'),
    taskTokens: {
      prepare: matchers.like(taskTokens.prepare),
      apply: matchers.like(taskTokens.apply),
      escalation: matchers.like(taskTokens.escalation),
    },
  }
}

export function addPrepareInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
): void {
  provider.addInteraction({
    states: [{description: workflowTaskProviderStates.prepareReady}],
    uponReceiving: 'an authenticated prepare task',
    withRequest: {
      method: 'POST',
      path: `/internal/migrations/${runId}/prepare`,
      headers: {
        authorization: authorizationMatcher(matchers, taskTokens.prepare),
        'content-type': 'application/json',
      },
      body: requestBody(matchers),
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': 'application/json'},
      body: {runId, reportPath, status: 'completed'},
    },
  })
}

export function addApplyInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
): void {
  provider.addInteraction({
    states: [{description: workflowTaskProviderStates.applyReady}],
    uponReceiving: 'an authenticated apply task',
    withRequest: {
      method: 'POST',
      path: `/internal/migrations/${runId}/apply`,
      headers: {
        authorization: authorizationMatcher(matchers, taskTokens.apply),
        'content-type': 'application/json',
      },
      body: requestBody(matchers),
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': 'application/json'},
      body: {runId, reportPath, status: 'completed'},
    },
  })
}

/**
 * The `apply` boundary's real (unmocked, production) behavior — see
 * `executeMigration` in src/workflow/step-runtime.ts — can report a
 * `MigrationTaskResult` with `status: 'in-progress'` in two cases: a
 * concurrent worker still holds the migration's durable lease, or the
 * bounded-batch runner (`applyBatch`) has more work queued for this run. In
 * either case the durable workflow engine is expected to re-invoke
 * `applyMigrationStep` later, and the worker must NOT record the run as
 * completed - see `worker.ts`'s `if (result.status === 'completed') { ... }`
 * guard around `recordWorkflowOutcome`.
 */
export function addApplyInProgressInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
): void {
  provider.addInteraction({
    states: [{description: workflowTaskProviderStates.applyInProgress}],
    uponReceiving: 'an authenticated apply task with bounded batch work still pending',
    withRequest: {
      method: 'POST',
      path: `/internal/migrations/${runId}/apply`,
      headers: {
        authorization: authorizationMatcher(matchers, taskTokens.apply),
        'content-type': 'application/json',
      },
      body: requestBody(matchers),
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': 'application/json'},
      body: {runId, reportPath, status: 'in-progress'},
    },
  })
}

/**
 * The `apply` boundary's real behavior can also report `status:
 * 'needs-elicitation'` with an embedded `ElicitationRecord` when a healing
 * decision requires human/agent approval (`BlockingElicitationFailure` -
 * see `executeMigrationAttempt`). This is the richest variant of the
 * discriminated `MigrationTaskResult` union and the one most likely to drift
 * silently if the wire schema ever changes, since it is the only variant
 * carrying a nested object.
 */
export function addApplyBlockedInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
): void {
  provider.addInteraction({
    states: [{description: workflowTaskProviderStates.applyBlocked}],
    uponReceiving: 'an authenticated apply task blocked on a healing elicitation',
    withRequest: {
      method: 'POST',
      path: `/internal/migrations/${runId}/apply`,
      headers: {
        authorization: authorizationMatcher(matchers, taskTokens.apply),
        'content-type': 'application/json',
      },
      body: requestBody(matchers),
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': 'application/json'},
      body: {
        runId,
        reportPath,
        status: 'needs-elicitation',
        elicitation: escalationElicitation(),
      },
    },
  })
}

export function addEscalationInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
): void {
  provider.addInteraction({
    states: [{description: workflowTaskProviderStates.escalationReady}],
    uponReceiving: 'an authenticated escalation report task',
    withRequest: {
      method: 'POST',
      path: `/internal/migrations/${runId}/escalation`,
      headers: {
        authorization: authorizationMatcher(matchers, taskTokens.escalation),
        'content-type': 'application/json',
      },
      body: {
        ...requestBody(matchers),
        elicitationId,
      },
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': 'application/json'},
      body: {
        runId,
        // The real handler computes its own temp-directory path per run - see
        // escalationReportPathExample's doc comment - so this can only be a
        // shape/type match, never an exact-value match.
        reportPath: matchers.like(escalationReportPathExample),
        status: 'completed',
      },
    },
  })
}
