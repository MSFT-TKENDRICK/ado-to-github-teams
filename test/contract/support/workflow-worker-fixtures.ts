// Shared fixture data for the `durable-migration-worker` Pact contract. Both the
// consumer test (`workflow-worker-consumer.test.ts`) and the provider verification
// test (`workflow-worker-provider.test.ts`) import these constants so the literal
// values recorded in the pact interactions and the values the real provider state
// handlers persist can never drift apart.
import type {CheckpointState} from '../../../src/types/index.js'
import {CHECKPOINT_SCHEMA_VERSION} from '../../../src/types/index.js'

export const workerConsumerName = 'ado-to-github-teams-cli'
export const workerProviderName = 'durable-migration-worker'

// Not a real credential: a fixture value shaped like the WORKFLOW_API_TOKEN the
// worker requires (`requiredSecret('WORKFLOW_API_TOKEN', 32)`), used only inside
// this test process. The pact interactions never assert this literal value directly;
// they use a regex matcher (see workflow-worker-pact.ts) instead.
export const apiToken = 'test-api-token-with-at-least-32-characters'

export const runId = '11111111-1111-4111-8111-111111111111'
export const workflowRunId = 'workflow-run-1'
export const elicitationId = 'elicit-11111111111111111111111111111111'
export const sessionElicitationId = 'elicit-22222222222222222222222222222222'

/**
 * Builds an `ElicitationRecord`-shaped fixture for `runId`. `target` is
 * parameterized (rather than hard-coded) because `CheckpointManager
 * .createElicitation()` treats any still-pending elicitation on the same run
 * with matching `phase`/`operation`/`target`/`failureMode` as the SAME
 * logical elicitation (see manager.ts) — the "sessions" (list) and
 * "elicitation resolution" provider-verification interactions below persist
 * two independently addressable elicitations for the same run, so they use
 * distinct `target` values to keep the provider's idempotency check from
 * merging them into one row regardless of interaction execution order.
 */
function makeBlockingElicitation(id: string, target: string) {
  return {
    id,
    runId,
    workflowRunId,
    hookToken: `migration-elicitation:${id}`,
    phase: 'create-teams',
    kind: 'healing',
    status: 'pending',
    summary: 'TransientFailure while attempting create-team for core',
    question: 'Skip failed create-team after operator review',
    choices: ['skip', 'abort'],
    operation: 'create-team',
    target,
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
  } as const
}

/** The elicitation resolved by the "elicitation resolution" interaction. */
export const blockingElicitation = makeBlockingElicitation(elicitationId, 'core')

/** The elicitation surfaced by the "sessions" (list) interaction. */
export const sessionBlockingElicitation = makeBlockingElicitation(
  sessionElicitationId,
  'core-session',
)

/** Checkpoint backing the "status" interaction: a fully mapped dry-run plan. */
export function statusCheckpoint(): CheckpointState {
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
    phase: 'dry-run',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    teamPlan: [
      {
        team: {slug: 'core', name: 'Core', privacy: 'closed'},
        kind: 'flat',
        sourceAdoTeamIds: ['ado-team-core'],
      },
    ],
    mappings: [
      {
        adoTeam: {
          id: 'ado-team-core',
          name: 'Core',
          projectId: 'project-1',
          projectName: 'Platform',
        },
        githubTeam: {slug: 'core', name: 'Core', privacy: 'closed'},
        memberMappings: [
          {
            adoIdentity: {
              id: 'ado-user-ada',
              displayName: 'Ada Lovelace',
              uniqueName: 'ada@contoso.com',
              isContainer: false,
            },
            githubUser: {login: 'ada', type: 'User'},
            mapped: true,
          },
        ],
        edgeCases: [],
      },
    ],
    repositoryGrants: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

/** Checkpoint backing the "latest" interaction: an early, unmapped run. */
export function latestCheckpoint(): CheckpointState {
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
    phase: 'map',
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

/** Checkpoint backing the "sessions" (list) interaction: a blocked run. */
export function blockedSessionCheckpoint(): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: `hash-${runId}`,
    runId,
    timestamp: '2026-01-01T00:01:00.000Z',
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
