// Effect-based HTTP exercises for the `durable-migration-worker` Pact contract.
// Both the consumer test (which asserts on the decoded response) and the
// provider test (which only needs to trigger the interaction so PactV3 will
// record and later verify it) call these functions, so the exact wire request
// each side sends can never drift from the interaction definitions in
// workflow-worker-pact.ts.
import {Effect} from 'effect'
import {
  makeWorkflowWorkerLayer,
  WorkflowWorkerServiceTag,
  type StartedMigration,
  type WorkerMigrationStatus,
} from '../../../src/workflow/client.js'
import type {MigrationSessionSummary} from '../../../src/workflow/elicitations.js'
import {elicitationId, runId} from './workflow-worker-fixtures.js'

function withWorker<A>(
  baseUrl: string,
  apiToken: string,
  effect: Effect.Effect<A, unknown, WorkflowWorkerServiceTag>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(makeWorkflowWorkerLayer(baseUrl, apiToken))),
  )
}

export function exerciseStart(
  baseUrl: string,
  apiToken: string,
): Promise<StartedMigration> {
  return withWorker(
    baseUrl,
    apiToken,
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      return yield* worker.start({
        runId,
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: true,
        concurrency: 4,
        prefix: 'ado-',
      })
    }),
  )
}

export function exerciseStatus(
  baseUrl: string,
  apiToken: string,
): Promise<WorkerMigrationStatus> {
  return withWorker(
    baseUrl,
    apiToken,
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      return yield* worker.status(runId)
    }),
  )
}

export function exerciseLatest(
  baseUrl: string,
  apiToken: string,
): Promise<WorkerMigrationStatus | null> {
  return withWorker(
    baseUrl,
    apiToken,
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      return yield* worker.latest
    }),
  )
}

export function exerciseApproval(baseUrl: string, apiToken: string): Promise<void> {
  return withWorker(
    baseUrl,
    apiToken,
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      yield* worker.approve(runId, {
        approved: true,
        approvedBy: 'operator@example.com',
        comment: 'Reviewed exact plan',
      })
    }),
  )
}

export function exerciseSessions(
  baseUrl: string,
  apiToken: string,
): Promise<readonly MigrationSessionSummary[]> {
  return withWorker(
    baseUrl,
    apiToken,
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      return yield* worker.list(true, 25)
    }),
  )
}

export function exerciseElicitation(
  baseUrl: string,
  apiToken: string,
): Promise<void> {
  return withWorker(
    baseUrl,
    apiToken,
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      yield* worker.resolveElicitation(runId, elicitationId, {
        action: 'skip',
        decidedBy: 'operator@example.com',
      })
    }),
  )
}

export function exerciseReport(baseUrl: string, apiToken: string): Promise<string> {
  return withWorker(
    baseUrl,
    apiToken,
    Effect.gen(function* () {
      const worker = yield* WorkflowWorkerServiceTag
      return yield* worker.report(runId)
    }),
  )
}
