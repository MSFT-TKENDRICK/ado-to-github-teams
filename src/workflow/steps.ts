import type {MigrationTaskResult, MigrationWorkflowInput} from './contracts.js'
import {decodeMigrationTaskResult} from './schemas.js'

async function workerTask(
  input: MigrationWorkflowInput,
  task: 'prepare' | 'apply',
): Promise<MigrationTaskResult> {
  const response = await fetch(
    `${input.workerBaseUrl}/internal/migrations/${encodeURIComponent(input.runId)}/${task}`,
    {
      method: 'POST',
      headers: {
        authorization: ['Bearer ', input.taskTokens[task]].join(''),
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
  return decodeMigrationTaskResult(await response.json())
}

export async function prepareMigrationStep(
  input: MigrationWorkflowInput,
  workflowRunId: string,
): Promise<MigrationTaskResult> {
  'use step'
  return workerTask({...input, workflowRunId}, 'prepare')
}

export async function applyMigrationStep(
  input: MigrationWorkflowInput,
  workflowRunId: string,
): Promise<MigrationTaskResult> {
  'use step'
  return workerTask({...input, workflowRunId}, 'apply')
}

export async function generateEscalationReportStep(
  input: MigrationWorkflowInput,
  workflowRunId: string,
  elicitationId: string,
): Promise<MigrationTaskResult> {
  'use step'
  const response = await fetch(
    `${input.workerBaseUrl}/internal/migrations/${encodeURIComponent(input.runId)}/escalation`,
    {
      method: 'POST',
      headers: {
        authorization: ['Bearer ', input.taskTokens.escalation].join(''),
        'content-type': 'application/json',
      },
      body: JSON.stringify({...input, workflowRunId, elicitationId}),
      signal: AbortSignal.timeout(60_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `Migration worker escalation report failed with HTTP ${response.status}: ${await response.text()}`,
    )
  }
  return decodeMigrationTaskResult(await response.json())
}
