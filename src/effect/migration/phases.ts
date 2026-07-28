import {Effect} from 'effect'
import type {CheckpointState, SkippedItem} from '../../types/index.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  ReportWriterTag,
} from '../services.js'
import {mapTeams} from './map-teams.js'
import type {EffectMigrationOptions} from './options.js'
import {createMigrationReport} from './state.js'
import type {MigrationStateStore} from './state-store.js'

export function fetchTeamsPhase(
  store: MigrationStateStore,
  projectName: string,
  timestamp: string,
) {
  return Effect.gen(function* () {
    const ado = yield* AdoServiceTag
    const state = yield* store.get
    const teams = yield* ado.getTeams(projectName)
    yield* store.save({
      ...state,
      phase: 'map',
      pendingTeams: teams,
      timestamp,
    })
  })
}

export function mapTeamsPhase(
  store: MigrationStateStore,
  options: EffectMigrationOptions,
  timestamp: string,
) {
  return Effect.gen(function* () {
    const state = yield* store.get
    const mappings = yield* mapTeams(state.pendingTeams, options)
    yield* store.save({
      ...state,
      phase: 'dry-run',
      mappings,
      edgeCases: mappings.flatMap((mapping) => mapping.edgeCases),
      timestamp,
    })
  })
}

export function advancePhase(
  store: MigrationStateStore,
  phase: CheckpointState['phase'],
  timestamp: string,
) {
  return Effect.gen(function* () {
    const approval = yield* ApprovalServiceTag
    const state = yield* store.get
    yield* store.save({
      ...state,
      phase,
      approvalHistory: yield* approval.history,
      timestamp,
    })
  })
}

export function writeMigrationReport(
  store: MigrationStateStore,
  options: {
    readonly dryRun: boolean
    readonly skippedItems: SkippedItem[]
    readonly outputPath: string
    readonly durationMs: number
    readonly timestamp: string
  },
) {
  return Effect.gen(function* () {
    const reportWriter = yield* ReportWriterTag
    const state = yield* store.get
    const report = createMigrationReport(
      state,
      options.dryRun,
      options.skippedItems,
      options.timestamp,
    )
    yield* reportWriter.write(report, options.outputPath, options.durationMs)
  })
}
