import {randomUUID} from 'node:crypto'
import {rm} from 'node:fs/promises'
import path from 'node:path'
import {Effect} from 'effect'
import {ValidationFailure, type DomainFailure} from '../effect/errors.js'
import type {ApprovalRequest} from '../types/index.js'
import {
  ImmediateMigrationPresentationPacingLayer,
  makeMigrationPresentationProgressLayer,
  makeSandboxInteractivePresentationPacingLayer,
  TerminalMigrationPresentation,
} from '../ui/migration-presentation.js'
import {renderApprovalRequestContext} from '../ui/approval-context.js'
import type {MigrationDashboardState} from '../ui/terminal-dashboard.js'
import {executeSandboxMigration} from './execution.js'
import type {SandboxScenario} from './schema.js'

export interface SandboxScenarioScope {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
}

export interface SandboxScenarioRunOptions {
  readonly scenario: SandboxScenario
  readonly configDigest: string
  readonly presentation: TerminalMigrationPresentation
  readonly runId: string
  readonly scope: SandboxScenarioScope
  readonly output: string
  readonly checkpointDirectory: string
  readonly apply: boolean
  readonly yes: boolean
  readonly concurrency: number
  readonly prefix?: string
  readonly suffix?: string
  readonly writeLine: (line: string) => void
  readonly confirmApproval: (request: ApprovalRequest) => Promise<boolean>
}

export type SandboxScenarioRunOutcome =
  | {readonly _tag: 'completed'; readonly runId: string; readonly reportPath: string}
  | {readonly _tag: 'expected-failure'; readonly failureTag: string; readonly message: string}

export function sandboxScenarioRunId(scenarioId: string): string {
  return `sandbox-${scenarioId}-${randomUUID()}`
}

export function sandboxCheckpointDirectory(scenarioId: string, runId: string): string {
  return path.join(process.cwd(), '.ado-github-teams', 'sandbox-checkpoints', scenarioId, runId)
}

export function sandboxReportPath(scenarioId: string): string {
  return path.resolve(process.cwd(), `sandbox-report-${scenarioId}.md`)
}

export function sandboxScenarioScope(
  scenario: SandboxScenario,
  overrides: Partial<SandboxScenarioScope> = {},
): SandboxScenarioScope {
  return {
    adoOrg: overrides.adoOrg ?? scenario.scope.adoOrg,
    adoProject: overrides.adoProject ?? scenario.scope.adoProject,
    githubOrg: overrides.githubOrg ?? scenario.scope.githubOrg,
  }
}

export function sandboxDashboardState(options: {
  readonly runId: string
  readonly scope: SandboxScenarioScope
  readonly apply: boolean
}): MigrationDashboardState {
  return {
    runId: options.runId,
    source: `${options.scope.adoOrg}/${options.scope.adoProject}`,
    target: options.scope.githubOrg,
    apply: options.apply,
    phase: 'fetch',
    status: 'running',
    message: 'Preparing deterministic provider boundaries.',
    sandbox: true,
  }
}

/**
 * The single production sandbox execution path. Both the noninteractive `migrate --sandbox`
 * one-shot and the interactive sandbox shell drive this function, so operators see identical
 * orchestration, approval, reporting, and presentation behaviour.
 */
export function runSandboxScenario(
  options: SandboxScenarioRunOptions,
): Effect.Effect<SandboxScenarioRunOutcome, DomainFailure> {
  const {presentation, scenario} = options
  const migration = executeSandboxMigration({
    scenario,
    configDigest: options.configDigest,
    checkpointDirectory: options.checkpointDirectory,
    progressLayer: makeMigrationPresentationProgressLayer(
      presentation,
      presentation.isInteractive
        ? makeSandboxInteractivePresentationPacingLayer()
        : ImmediateMigrationPresentationPacingLayer,
    ),
    migration: {
      ...options.scope,
      apply: options.apply,
      output: options.output,
      concurrency: Math.max(1, options.concurrency),
      autoResume: false,
      runId: options.runId,
      ...(options.prefix ? {prefix: options.prefix} : {}),
      ...(options.suffix ? {suffix: options.suffix} : {}),
    },
    approval: {
      yesFlag: options.yes,
      writeLine: (line) =>
        presentation.isInteractive ? Effect.void : Effect.sync(() => options.writeLine(line)),
      decide: (runtime, request) => {
        const decision = runtime.requestApproval(
          request,
          options.yes ? undefined : async () => options.confirmApproval(request),
        )
        if (!presentation.isInteractive) {
          return options.yes ? decision : presentation.withApproval(request, decision)
        }
        return presentation.withApproval(request, decision, {
          prompt: !options.yes,
          afterSuspend: () => {
            for (const line of renderApprovalRequestContext(request)) {
              options.writeLine(line)
            }
            if (options.yes) {
              options.writeLine('Using the predefined sandbox decision from --yes.')
            }
          },
        })
      },
    },
  })

  return Effect.acquireUseRelease(
    Effect.sync(() => {
      presentation.start()
    }),
    () =>
      migration.pipe(
        Effect.flatMap((execution): Effect.Effect<SandboxScenarioRunOutcome, DomainFailure> => {
          const result = execution.result
          if (result._tag === 'Left') {
            const failure = result.left
            const expected =
              scenario.expected.outcome === 'failure' &&
              failure._tag === scenario.expected.failureType &&
              'service' in failure &&
              failure.service === scenario.expected.failureService &&
              failure.message.includes(scenario.expected.failureIncludes ?? '')
            return expected
              ? Effect.succeed({
                  _tag: 'expected-failure',
                  failureTag: failure._tag,
                  message: failure.message,
                })
              : Effect.fail(failure)
          }
          return scenario.expected.outcome === 'failure'
            ? Effect.fail(
                new ValidationFailure({
                  service: 'sandbox',
                  message: `Scenario ${scenario.id} succeeded but expected a failure`,
                }),
              )
            : Effect.succeed({
                _tag: 'completed',
                runId: result.right.runId,
                reportPath: result.right.reportPath,
              })
        }),
      ),
    () =>
      Effect.sync(() => {
        presentation.stop()
      }).pipe(
        Effect.zipRight(
          Effect.tryPromise({
            try: async () => rm(options.checkpointDirectory, {recursive: true, force: true}),
            catch: () =>
              new ValidationFailure({
                service: 'sandbox',
                message: `Unable to remove sandbox checkpoints at ${options.checkpointDirectory}`,
              }),
          }).pipe(
            Effect.catchTag('ValidationFailure', (failure) =>
              Effect.sync(() => options.writeLine(failure.message)),
            ),
          ),
        ),
      ),
  )
}
