import {Effect, Layer, type Either} from 'effect'
import {
  makeApprovalLayer,
  makeCheckpointLayer,
  ReportWriterLiveLayer,
  type ApprovalLayerOptions,
} from '../effect/layers.js'
import {
  runEffectMigration,
  type EffectMigrationOptions,
  type EffectMigrationResult,
} from '../effect/migration.js'
import type {DomainFailure} from '../effect/errors.js'
import type {MigrationProgressReporterTag} from '../ui/migration-progress.js'
import type {SandboxTranscriptEntry, TeamTopologyConfig} from '../types/index.js'
import type {SandboxScenario} from './schema.js'
import {makeSandboxBoundaryLayers} from './layers.js'
import {SandboxRuntime} from './runtime.js'

export interface SandboxExecutionOptions {
  readonly scenario: SandboxScenario
  readonly configDigest: string
  readonly checkpointDirectory: string
  readonly progressLayer: Layer.Layer<MigrationProgressReporterTag>
  readonly migration: Omit<EffectMigrationOptions, 'topology' | 'sandboxReport'>
  readonly approval?: Omit<ApprovalLayerOptions, 'decide'> & {
    readonly decide?: (
      runtime: SandboxRuntime,
      request: Parameters<SandboxRuntime['requestApproval']>[0],
    ) => Effect.Effect<boolean, DomainFailure>
  }
}

export interface SandboxExecutionResult {
  readonly result: Either.Either<EffectMigrationResult, DomainFailure>
  readonly runtime: SandboxRuntime
}

function toTeamTopologyConfig(
  topology: NonNullable<SandboxScenario['topology']>,
): TeamTopologyConfig {
  return {
    version: topology.version,
    organizationalUnit: {
      name: topology.organizationalUnit.name,
      ...(topology.organizationalUnit.description === undefined
        ? {}
        : {description: topology.organizationalUnit.description}),
    },
    ...(topology.projectTeam === undefined
      ? {}
      : {
          projectTeam: {
            ...(topology.projectTeam.name === undefined ? {} : {name: topology.projectTeam.name}),
            ...(topology.projectTeam.description === undefined
              ? {}
              : {description: topology.projectTeam.description}),
          },
        }),
    repositories: topology.repositories.map((repository) => ({
      repository: repository.repository,
      teamName: repository.teamName,
      ...(repository.description === undefined ? {} : {description: repository.description}),
      sourceAdoTeams: [...repository.sourceAdoTeams],
      role: repository.role,
    })),
    ...(topology.allowAdmin === undefined ? {} : {allowAdmin: topology.allowAdmin}),
  }
}

export function executeSandboxMigration(
  options: SandboxExecutionOptions,
): Effect.Effect<SandboxExecutionResult, DomainFailure> {
  const transcript: SandboxTranscriptEntry[] = []
  const runtime = new SandboxRuntime(options.scenario, transcript)
  const approval = options.approval ?? {yesFlag: true}
  const approvalLayer = makeApprovalLayer({
    ...approval,
    decide: (request) => approval.decide?.(runtime, request) ?? runtime.requestApproval(request),
  })
  const topology = options.scenario.topology
    ? {
        config: toTeamTopologyConfig(options.scenario.topology),
        digest: options.configDigest,
      }
    : undefined
  const layer = Layer.mergeAll(
    makeSandboxBoundaryLayers(runtime),
    approvalLayer,
    makeCheckpointLayer(options.checkpointDirectory),
    ReportWriterLiveLayer,
    options.progressLayer,
  )
  const migration = runEffectMigration({
    ...options.migration,
    ...(topology ? {topology} : {}),
    sandboxReport: {
      scenario: options.scenario.id,
      title: options.scenario.title,
      configDigest: options.configDigest,
      transcript,
    },
  })

  return migration.pipe(
    Effect.provide(layer),
    Effect.either,
    Effect.tap(() => runtime.verify()),
    Effect.map((result) => ({result, runtime})),
  )
}
