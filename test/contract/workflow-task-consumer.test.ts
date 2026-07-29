import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  addApplyInteraction,
  addPrepareInteraction,
} from './support/workflow-task-pact.js'
import {
  exerciseApply,
  exercisePrepare,
} from './support/workflow-task-exercises.js'
import {
  reportPath,
  runId,
  taskConsumerName,
  taskProviderName,
} from './support/workflow-task-fixtures.js'

type PactV3Type = typeof import('@pact-foundation/pact').PactV3

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

async function taskProvider(): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: taskConsumerName,
    provider: taskProviderName,
    dir: path.resolve('test/contract/pacts'),
  })
}

// Consumer-side coverage for the durable workflow engine's own task-callback
// client (src/workflow/steps.ts). This exercises the SAME first-party HTTP
// boundary that workflow-task-provider.test.ts provider-verifies against the
// real src/worker.ts app — see that file, and workflow-task-pact.ts, for the
// shared interaction/state definitions.
//
// `.sequential` keeps both tests on the single stable consumer/provider pair
// from racing each other's mock-server ports.
contractDescribe.sequential('workflow task worker consumer contract', () => {
  it('prepare executes through the authenticated worker boundary', async () => {
    const provider = await taskProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addPrepareInteraction(provider, MatchersV3)

    await provider.executeTest(async (mockserver) => {
      const result = await exercisePrepare(mockserver.url)
      expect(result).toEqual({runId, reportPath, status: 'completed'})
    })
  })

  it('apply executes through the authenticated worker boundary', async () => {
    const provider = await taskProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addApplyInteraction(provider, MatchersV3)

    await provider.executeTest(async (mockserver) => {
      const result = await exerciseApply(mockserver.url)
      expect(result).toEqual({runId, reportPath, status: 'completed'})
    })
  })
})
