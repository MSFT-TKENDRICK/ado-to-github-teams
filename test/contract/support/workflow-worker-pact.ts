// Interaction definitions for the `durable-migration-worker` Pact contract,
// shared between the consumer test (workflow-worker-consumer.test.ts) and the
// provider verification test (workflow-worker-provider.test.ts). Defining each
// interaction once and adding it from both a consumer-side and a provider-side
// `PactV3` instance (each writing to its own pact file, same stable consumer/
// provider names) keeps the consumer example and the provider verification
// target byte-for-byte consistent without sharing a file on disk between test
// files running in parallel Vitest workers.
import {
  elicitationId,
  runId,
  sessionBlockingElicitation,
  sessionElicitationId,
  workflowRunId,
} from './workflow-worker-fixtures.js'

type PactV3Type = typeof import('@pact-foundation/pact').PactV3
type MatchersV3Type = typeof import('@pact-foundation/pact').MatchersV3

export const workflowWorkerProviderStates = {
  started: `migration ${runId} is already linked to workflow ${workflowRunId}`,
  statusPlan: `migration ${runId} has a persisted dry-run plan linked to workflow ${workflowRunId}`,
  latestPlan: `migration ${runId} is the most recently updated migration, linked to workflow ${workflowRunId}`,
  approvable: `migration ${runId} exists and can accept an approval decision`,
  blockedSessions: `migration ${runId} is blocked on elicitation ${sessionElicitationId}`,
  pendingElicitation: `migration ${runId} has a pending elicitation ${elicitationId}`,
  reportAvailable: `migration ${runId} has a completed report on disk`,
} as const

function authorizationMatcher(matchers: MatchersV3Type, token: string) {
  const value = ['Bearer', token].join(' ')
  return matchers.regex(/^Bearer\s.{16,}$/, value)
}

function jsonContentTypeMatcher(matchers: MatchersV3Type) {
  return matchers.regex(/^application\/json(;.*)?$/, 'application/json')
}

export function addStartInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  provider.addInteraction({
    states: [{description: workflowWorkerProviderStates.started}],
    uponReceiving: 'a migration start request for an already-queued run',
    withRequest: {
      method: 'POST',
      path: '/api/migrations',
      headers: {
        authorization: authorizationMatcher(matchers, apiToken),
        'content-type': 'application/json',
      },
      body: {
        runId,
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: true,
        concurrency: 4,
        prefix: 'ado-',
      },
    },
    willRespondWith: {
      status: 202,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
      body: {runId, workflowRunId, status: 'queued'},
    },
  })
}

export function addStatusInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  provider.addInteraction({
    states: [{description: workflowWorkerProviderStates.statusPlan}],
    uponReceiving: 'a migration status request',
    withRequest: {
      method: 'GET',
      path: `/api/migrations/${runId}`,
      headers: {authorization: authorizationMatcher(matchers, apiToken)},
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
      body: {
        workflowRunId,
        workflowStatus: 'running',
        migration: {
          runId,
          phase: 'dry-run',
          updatedAt: '2026-01-01T00:00:00.000Z',
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'contoso',
          apply: true,
          concurrency: 4,
          plan: {
            githubOrg: 'contoso',
            teams: [{slug: 'core', name: 'Core', kind: 'flat'}],
            memberAssignments: [{team: 'core', login: 'ada'}],
            repositoryGrants: [],
          },
          approvals: [],
          blockingElicitations: [],
        },
      },
    },
  })
}

export function addLatestInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  provider.addInteraction({
    states: [{description: workflowWorkerProviderStates.latestPlan}],
    uponReceiving: 'a latest migration status request',
    withRequest: {
      method: 'GET',
      path: '/api/migrations/latest',
      headers: {authorization: authorizationMatcher(matchers, apiToken)},
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
      body: {
        workflowRunId,
        workflowStatus: 'running',
        migration: {
          runId,
          phase: 'map',
          updatedAt: '2026-01-01T00:00:00.000Z',
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'contoso',
          apply: true,
          concurrency: 4,
          plan: {
            githubOrg: 'contoso',
            teams: [],
            memberAssignments: [],
          },
          approvals: [],
          blockingElicitations: [],
        },
      },
    },
  })
}

export function addApprovalInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  provider.addInteraction({
    states: [{description: workflowWorkerProviderStates.approvable}],
    uponReceiving: 'an approval submission',
    withRequest: {
      method: 'POST',
      path: `/api/migrations/${runId}/approval`,
      headers: {
        authorization: authorizationMatcher(matchers, apiToken),
        'content-type': 'application/json',
      },
      body: {
        approved: true,
        approvedBy: 'operator@example.com',
        comment: 'Reviewed exact plan',
      },
    },
    willRespondWith: {
      status: 202,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
      body: {runId, accepted: true},
    },
  })
}

export function addSessionsInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  provider.addInteraction({
    states: [{description: workflowWorkerProviderStates.blockedSessions}],
    uponReceiving: 'a blocked migration session list request',
    withRequest: {
      method: 'GET',
      path: '/api/migrations',
      query: {blocking: ['true'], limit: ['25']},
      headers: {authorization: authorizationMatcher(matchers, apiToken)},
    },
    willRespondWith: {
      status: 200,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
      body: [
        {
          runId,
          workflowRunId,
          workflowStatus: 'blocked',
          phase: 'create-teams',
          updatedAt: '2026-01-01T00:01:00.000Z',
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'contoso',
          blockingElicitations: [sessionBlockingElicitation],
        },
      ],
    },
  })
}

export function addElicitationInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  provider.addInteraction({
    states: [{description: workflowWorkerProviderStates.pendingElicitation}],
    uponReceiving: 'an elicitation resolution',
    withRequest: {
      method: 'POST',
      path: `/api/migrations/${runId}/elicitations/${elicitationId}`,
      headers: {
        authorization: authorizationMatcher(matchers, apiToken),
        'content-type': 'application/json',
      },
      body: {
        action: 'skip',
        decidedBy: 'operator@example.com',
      },
    },
    willRespondWith: {
      status: 202,
      headers: {'Content-Type': jsonContentTypeMatcher(matchers)},
      body: {runId, elicitationId, accepted: true},
    },
  })
}

export function addReportInteraction(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  provider.addInteraction({
    states: [{description: workflowWorkerProviderStates.reportAvailable}],
    uponReceiving: 'a migration report request',
    withRequest: {
      method: 'GET',
      path: `/api/migrations/${runId}/report`,
      headers: {authorization: authorizationMatcher(matchers, apiToken)},
    },
    willRespondWith: {
      status: 200,
      headers: {
        'Content-Type': matchers.regex(/^text\/markdown(;.*)?$/, 'text/markdown'),
      },
      body: '# Migration report',
    },
  })
}

/** Adds every worker-boundary interaction; used by the provider verification test. */
export function addAllWorkflowWorkerInteractions(
  provider: InstanceType<PactV3Type>,
  matchers: MatchersV3Type,
  apiToken: string,
): void {
  addStartInteraction(provider, matchers, apiToken)
  addStatusInteraction(provider, matchers, apiToken)
  addLatestInteraction(provider, matchers, apiToken)
  addApprovalInteraction(provider, matchers, apiToken)
  addSessionsInteraction(provider, matchers, apiToken)
  addElicitationInteraction(provider, matchers, apiToken)
  addReportInteraction(provider, matchers, apiToken)
}
