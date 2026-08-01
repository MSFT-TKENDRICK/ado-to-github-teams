import {mkdir} from 'node:fs/promises'
import path from 'node:path'
import {Effect} from 'effect'
import {ValidationFailure, type DomainFailure} from '../effect/errors.js'
import {
  ImmediateMigrationPresentationPacingLayer,
  makeMigrationPresentationProgressLayer,
  TerminalMigrationPresentation,
  type MigrationPresentationSnapshot,
} from '../ui/migration-presentation.js'
import {findSandboxScenario, type LoadedSandboxCatalog} from './config.js'
import {executeSandboxMigration} from './execution.js'

export interface SandboxPresentationTrace {
  readonly scenarioId: string
  readonly runId: string
  readonly outcome: 'success' | 'failure'
  readonly failureTag?: string
  readonly snapshots: readonly MigrationPresentationSnapshot[]
}

export interface SandboxPresentationTraceOptions {
  readonly loaded: LoadedSandboxCatalog
  readonly scenarioId: string
  readonly directory: string
  readonly runId: string
}

export function runSandboxPresentationTrace(
  options: SandboxPresentationTraceOptions,
): Effect.Effect<SandboxPresentationTrace, DomainFailure> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => mkdir(options.directory, {recursive: true}),
      catch: () =>
        new ValidationFailure({
          service: 'sandbox',
          message: `Unable to create presentation trace directory for ${options.scenarioId}`,
        }),
    })
    const scenario = yield* findSandboxScenario(options.loaded.catalog, options.scenarioId)
    const presentation = new TerminalMigrationPresentation(
      {
        runId: options.runId,
        source: `${scenario.scope.adoOrg}/${scenario.scope.adoProject}`,
        target: scenario.scope.githubOrg,
        apply: scenario.mode === 'apply',
        phase: 'fetch',
        status: 'running',
        message: 'Preparing deterministic provider boundaries.',
        sandbox: true,
      },
      {enabled: false},
    )
    const execution = yield* executeSandboxMigration({
      scenario,
      configDigest: options.loaded.digest,
      checkpointDirectory: path.join(options.directory, 'checkpoints'),
      progressLayer: makeMigrationPresentationProgressLayer(
        presentation,
        ImmediateMigrationPresentationPacingLayer,
      ),
      migration: {
        ...scenario.scope,
        apply: scenario.mode === 'apply',
        concurrency: 2,
        output: path.join(options.directory, 'report.md'),
        autoResume: false,
        runId: options.runId,
      },
      approval: {
        yesFlag: true,
        writeLine: () => Effect.void,
        decide: (runtime, request) =>
          presentation.withApproval(request, runtime.requestApproval(request)),
      },
    })
    const result = execution.result

    if (scenario.expected.outcome === 'success' && result._tag === 'Left') {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Presentation trace ${scenario.id} failed with ${result.left._tag}`,
        }),
      )
    }
    if (scenario.expected.outcome === 'failure' && result._tag === 'Right') {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Presentation trace ${scenario.id} succeeded but expected a failure`,
        }),
      )
    }
    if (
      scenario.expected.outcome === 'failure' &&
      result._tag === 'Left' &&
      result.left._tag !== scenario.expected.failureType
    ) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Presentation trace ${scenario.id} failed with ${result.left._tag}; expected ${scenario.expected.failureType}`,
        }),
      )
    }

    return {
      scenarioId: scenario.id,
      runId: options.runId,
      outcome: result._tag === 'Right' ? 'success' : 'failure',
      ...(result._tag === 'Left' ? {failureTag: result.left._tag} : {}),
      snapshots: presentation.snapshots(),
    }
  })
}
