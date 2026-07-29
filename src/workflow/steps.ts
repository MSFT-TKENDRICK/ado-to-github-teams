import type {MigrationTaskResult, MigrationWorkflowInput} from './contracts.js'

function taskResult(input: unknown): MigrationTaskResult {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('runId' in input) ||
    typeof input.runId !== 'string' ||
    !('reportPath' in input) ||
    typeof input.reportPath !== 'string'
  ) {
    throw new Error('Worker returned an invalid migration task result.')
  }
  return {runId: input.runId, reportPath: input.reportPath}
}

async function workerTask(
  input: MigrationWorkflowInput,
  task: 'prepare' | 'apply',
): Promise<MigrationTaskResult> {
  const response = await fetch(
    `${input.workerBaseUrl}/internal/migrations/${encodeURIComponent(input.runId)}/${task}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.taskToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10 * 60_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Migration worker ${task} failed with HTTP ${response.status}: ${await response.text()}`,
    )
  }
  return taskResult(await response.json())
}

export async function prepareMigrationStep(
  input: MigrationWorkflowInput,
  workflowRunId: string,
): Promise<{reportPath: string; runId: string}> {
  "use step";
  return workerTask({...input, workflowRunId}, 'prepare')
}

export async function applyMigrationStep(
  input: MigrationWorkflowInput,
  workflowRunId: string,
): Promise<{reportPath: string; runId: string}> {
  "use step";
  return workerTask({...input, workflowRunId}, 'apply')
}
