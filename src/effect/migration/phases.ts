import {Effect} from 'effect'
import type {CheckpointState, SandboxReportMetadata} from '../../types/index.js'
import {AdoServiceTag, ApprovalServiceTag, ReportWriterTag} from '../services.js'
import {mapTeam} from './map-team.js'
import {mapHierarchy, validateUniqueTeamSlugs} from './map-teams.js'
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
    if (options.topology) {
      const state = yield* store.get
      const planned = yield* mapHierarchy(state.pendingTeams, {
        ...options,
        topology: options.topology,
      })
      yield* store.save({
        ...state,
        phase: 'dry-run',
        mappings: planned.mappings,
        teamPlan: planned.teamPlan,
        repositoryGrants: planned.repositoryGrants,
        edgeCases: planned.mappings.flatMap((mapping) => mapping.edgeCases),
        timestamp,
      })
      return
    }

    const ado = yield* AdoServiceTag
    let state = yield* store.get
    const completedTeamIds = new Set(state.mappings.map((mapping) => mapping.adoTeam.id))
    const pending = state.pendingTeams.filter((team) => !completedTeamIds.has(team.id))
    const batchSize = Math.max(1, options.concurrency)

    for (let index = 0; index < pending.length; index += batchSize) {
      const batch = pending.slice(index, index + batchSize)
      const mappedBatch = yield* Effect.forEach(
        batch,
        (team) =>
          Effect.gen(function* () {
            const members = yield* ado.getTeamMembers(team.projectId, team.id)
            return yield* mapTeam(team, members, options)
          }),
        {concurrency: batchSize},
      )
      state = yield* store.get
      const mappingsByTeamId = new Map(
        [...state.mappings, ...mappedBatch].map((mapping) => [mapping.adoTeam.id, mapping]),
      )
      const mappings = state.pendingTeams.flatMap((team) => {
        const mapping = mappingsByTeamId.get(team.id)
        return mapping ? [mapping] : []
      })
      yield* validateUniqueTeamSlugs(mappings)
      yield* store.save({
        ...state,
        mappings,
        edgeCases: mappings.flatMap((mapping) => mapping.edgeCases),
        timestamp,
      })
    }

    state = yield* store.get
    yield* validateUniqueTeamSlugs(state.mappings)
    yield* store.save({
      ...state,
      phase: 'dry-run',
      teamPlan: state.mappings.map((mapping) => ({
        team: mapping.githubTeam,
        kind: 'flat' as const,
        sourceAdoTeamIds: [mapping.adoTeam.id],
      })),
      repositoryGrants: [],
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
    readonly outputPath: string
    readonly durationMs: number
    readonly timestamp: string
    readonly sandboxReport?: SandboxReportMetadata
  },
) {
  return Effect.gen(function* () {
    const reportWriter = yield* ReportWriterTag
    const state = yield* store.get
    const baseReport = createMigrationReport(state, options.dryRun, options.timestamp)
    const report = options.sandboxReport
      ? {...baseReport, sandbox: options.sandboxReport}
      : baseReport
    yield* reportWriter.write(report, options.outputPath, options.durationMs)
  })
}
