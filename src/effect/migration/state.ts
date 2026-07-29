import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointState,
  type FailureLogEntry,
  type MigrationReport,
} from '../../types/index.js'
import {configurationHash} from '../../checkpoints/configuration.js'
import {toFailureMode, type DomainFailure} from '../errors.js'
import type {EffectMigrationOptions} from './options.js'

export function createInitialState(
  options: EffectMigrationOptions,
  runId: string,
  timestamp: string,
): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: configurationHash(options),
    runId,
    timestamp,
    adoOrg: options.adoOrg,
    adoProject: options.adoProject,
    githubOrg: options.githubOrg,
    migrationConfig: {
      apply: options.apply,
      prefix: options.prefix ?? '',
      suffix: options.suffix ?? '',
    },
    phase: 'fetch',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

export function createMigrationReport(
  state: CheckpointState,
  dryRun: boolean,
  timestamp: string,
): MigrationReport {
  return {
    runId: state.runId,
    timestamp,
    adoOrg: state.adoOrg,
    adoProject: state.adoProject,
    githubOrg: state.githubOrg,
    dryRun,
    mappings: state.mappings,
    edgeCases: state.edgeCases,
    skippedItems: state.skippedItems,
    failureLog: state.failureLog,
    approvalHistory: state.approvalHistory,
  }
}

export function appendFailure(
  state: CheckpointState,
  failure: DomainFailure,
  action: string,
): CheckpointState {
  const entry: FailureLogEntry = {
    failureMode: toFailureMode(failure),
    error: failure.message,
    healingAction: action,
    resolved: false,
  }
  return {
    ...state,
    failureLog: [...state.failureLog, entry],
  }
}
