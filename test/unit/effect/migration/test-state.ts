import {Effect} from 'effect'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointState,
  type MappingResult,
} from '../../../../src/types/index.js'
import type {MigrationStateStore} from '../../../../src/effect/migration/state-store.js'

export const mapping: MappingResult = {
  adoTeam: {
    id: 'team-1',
    name: 'Platform',
    projectId: 'project-1',
    projectName: 'Engineering',
  },
  githubTeam: {
    slug: 'platform',
    name: 'Platform',
    privacy: 'closed',
  },
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

export function checkpointState(
  overrides: Partial<CheckpointState> = {},
): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Engineering',
    githubOrg: 'contoso',
    migrationConfig: {
      apply: true,
      prefix: '',
      suffix: '',
    },
    phase: 'create-teams',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [mapping],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
    ...overrides,
  }
}

export function memoryStateStore(
  initial: CheckpointState,
  onSave?: (state: CheckpointState) => void,
): {readonly store: MigrationStateStore; readonly state: () => CheckpointState} {
  let current = structuredClone(initial)
  return {
    store: {
      get: Effect.sync(() => structuredClone(current)),
      save: (state) =>
        Effect.sync(() => {
          current = structuredClone(state)
          onSave?.(structuredClone(state))
        }),
    },
    state: () => structuredClone(current),
  }
}
