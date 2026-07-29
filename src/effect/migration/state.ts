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
      topologyDigest: options.topology?.digest ?? '',
      ...(options.output ? {output: options.output} : {}),
      concurrency: Math.max(1, options.concurrency),
    },
    phase: 'fetch',
    completedTeams: [],
    completedMemberPairs: [],
    completedRepositoryGrants: [],
    pendingTeams: [],
    mappings: [],
    teamPlan: [],
    repositoryGrants: [],
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
    ...(state.teamPlan ? {teamPlan: state.teamPlan} : {}),
    ...(state.repositoryGrants ? {repositoryGrants: state.repositoryGrants} : {}),
  }
}

export function appendFailure(
  state: CheckpointState,
  failure: DomainFailure,
  action: string,
  target: string,
): CheckpointState {
  const entry: FailureLogEntry = {
    failureMode: toFailureMode(failure),
    failureTag: failure._tag,
    error: failure.message,
    healingAction: action,
    target,
    resolved: false,
  }
  return {
    ...state,
    failureLog: [...state.failureLog, entry],
  }
}

export function resolveAutomaticRetry(
  state: CheckpointState,
  target: string,
): CheckpointState {
  return {
    ...state,
    failureLog: state.failureLog.map((entry) =>
      entry.automaticRetry && entry.target === target && !entry.resolved
        ? {...entry, resolved: true}
        : entry,
    ),
  }
}
