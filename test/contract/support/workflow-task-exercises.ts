// Shared exercise functions for the `durable-migration-worker-internal-api`
// Pact contract. Both the consumer test and the provider verification test
// call these to drive the real production client
// (`src/workflow/steps.ts`'s `prepareMigrationStep`/`applyMigrationStep`)
// against a mock (consumer side) or real (provider side) HTTP server, so both
// tests exercise the exact same request/response wire format.
import {
  applyMigrationStep,
  prepareMigrationStep,
} from '../../../src/workflow/steps.js'
import type {MigrationTaskResult} from '../../../src/workflow/contracts.js'
import {workflowInput, workflowRunId} from './workflow-task-fixtures.js'

export async function exercisePrepare(
  workerBaseUrl: string,
): Promise<MigrationTaskResult> {
  return prepareMigrationStep(workflowInput(workerBaseUrl), workflowRunId)
}

export async function exerciseApply(
  workerBaseUrl: string,
): Promise<MigrationTaskResult> {
  return applyMigrationStep(workflowInput(workerBaseUrl), workflowRunId)
}
