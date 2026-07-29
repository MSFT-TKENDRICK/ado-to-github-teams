// Interaction definitions for the `durable-migration-worker-internal-api`
// Pact contract, shared between the consumer test
// (workflow-task-consumer.test.ts) and the provider verification test
// (workflow-task-provider.test.ts). This boundary is the task-callback API
// the durable workflow engine's own step functions call back into
// `src/worker.ts` on (`/internal/migrations/:runId/{prepare,apply}`) — a
// first-party boundary distinct from the operator-facing `/api/migrations`
// boundary covered by workflow-worker-pact.ts.
import {reportPath, runId, taskToken, workflowInput} from './workflow-task-fixtures.js'

type PactV3Type = typeof import('@pact-foundation/pact').PactV3
type MatchersV3Type = typeof import('@pact-foundation/pact').MatchersV3

export const workflowTaskProviderStates = {
  prepareReady: `migration ${runId} can execute its prepare (dry-run) task`,
  applyReady: `migration ${runId} can execute its apply task`,
} as const

function authorizationMatcher(matchers: MatchersV3Type, token: string) {
  const value = ['Bearer', token].join(' ')
  return matchers.regex(/^Bearer\s.{16,}$/, value)
}

function jsonContentTypeMatcher(matchers: MatchersV3Type) {
  return matchers.regex(/^application\/json(;.*)?$/, 'application/json')
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
    taskToken: matchers.like(taskToken),
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
        authorization: authorizationMatcher(matchers, taskToken),
        'content-type': 'application/json',
      },
      body: requestBody(matchers),
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
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
        authorization: authorizationMatcher(matchers, taskToken),
        'content-type': 'application/json',
      },
      body: requestBody(matchers),
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
      body: {runId, reportPath, status: 'completed'},
    },
  })
}
