import path from 'node:path'
import {describe, expect, it} from 'vitest'
import type {MigrationWorkflowInput} from '../../src/workflow/contracts.js'
import {
  applyMigrationStep,
  prepareMigrationStep,
} from '../../src/workflow/steps.js'

type PactV3Type = typeof import('@pact-foundation/pact').PactV3

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip
const runId = '11111111-1111-4111-8111-111111111111'
const taskToken = 'scoped-workflow-task-token'
const workflowRunId = 'wrun_01K00000000000000000000000'

async function workerProvider(
  testName: string,
): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: `vercel-workflow-${testName}`,
    provider: 'durable-migration-worker-internal-api',
    dir: path.resolve('test/contract/pacts'),
  })
}

function workflowInput(workerBaseUrl: string): MigrationWorkflowInput {
  return {
    runId,
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    apply: true,
    concurrency: 4,
    workerBaseUrl,
    taskToken,
    output: `/data/reports/migration-report-${runId}.md`,
  }
}

contractDescribe('workflow task worker consumer contracts', () => {
  for (const task of ['prepare', 'apply'] as const) {
    it(`${task} executes through the authenticated worker boundary`, async () => {
      const provider = await workerProvider(task)
      const {MatchersV3} = await import('@pact-foundation/pact')
      const body = {
        ...workflowInput('http://worker.invalid'),
        workflowRunId,
        workerBaseUrl: MatchersV3.like('http://worker.invalid'),
      }
      provider.addInteraction({
        uponReceiving: `an authenticated ${task} task`,
        withRequest: {
          method: 'POST',
          path: `/internal/migrations/${runId}/${task}`,
          headers: {
            authorization: `Bearer ${taskToken}`,
            'content-type': 'application/json',
          },
          body,
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            runId,
            reportPath: `/data/reports/migration-report-${runId}.md`,
          },
        },
      })

      await provider.executeTest(async (mockserver) => {
        const input = workflowInput(mockserver.url)
        const result =
          task === 'prepare'
            ? await prepareMigrationStep(input, workflowRunId)
            : await applyMigrationStep(input, workflowRunId)
        expect(result).toEqual({
          runId,
          reportPath: `/data/reports/migration-report-${runId}.md`,
        })
      })
    })
  }
})
