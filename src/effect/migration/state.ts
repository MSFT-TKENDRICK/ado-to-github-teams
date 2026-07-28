import type {
  CheckpointState,
  FailureLogEntry,
  MigrationReport,
  SkippedItem,
} from '../../types/index.js'
import {toFailureMode, type DomainFailure} from '../errors.js'
import type {EffectMigrationOptions} from './options.js'

export function createInitialState(
  options: EffectMigrationOptions,
  runId: string,
  timestamp: string,
): CheckpointState {
  return {
    runId,
    timestamp,
    adoOrg: options.adoOrg,
    adoProject: options.adoProject,
    githubOrg: options.githubOrg,
    phase: 'fetch',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [],
    edgeCases: [],
    failureLog: [],
    approvalHistory: [],
  }
}

export function createMigrationReport(
  state: CheckpointState,
  dryRun: boolean,
  skippedItems: SkippedItem[],
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
    skippedItems,
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
