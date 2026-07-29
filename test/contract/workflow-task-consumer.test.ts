import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  addApplyBlockedInteraction,
  addApplyInProgressInteraction,
  addApplyInteraction,
  addEscalationInteraction,
  addPrepareInteraction,
} from './support/workflow-task-pact.js'
import {
  exerciseApply,
  exerciseEscalation,
  exercisePrepare,
} from './support/workflow-task-exercises.js'
import {
  escalationElicitation,
  escalationReportPathExample,
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

  // PR #26 (durable workflow recovery) changed MigrationTaskResult into a
  // discriminated union: prepare/apply can report 'completed', 'in-progress'
  // (lease contention or bounded-batch continuation), or 'needs-elicitation'
  // (a healing decision requires approval). The two tests below cover the
  // variants the plain "completed" test above does not.
  it('apply reports in-progress when bounded batch work remains', async () => {
    const provider = await taskProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addApplyInProgressInteraction(provider, MatchersV3)

    await provider.executeTest(async (mockserver) => {
      const result = await exerciseApply(mockserver.url)
      expect(result).toEqual({runId, reportPath, status: 'in-progress'})
    })
  })

  it('apply reports needs-elicitation with the blocking elicitation embedded', async () => {
    const provider = await taskProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addApplyBlockedInteraction(provider, MatchersV3)

    await provider.executeTest(async (mockserver) => {
      const result = await exerciseApply(mockserver.url)
      expect(result).toEqual({
        runId,
        reportPath,
        status: 'needs-elicitation',
        elicitation: escalationElicitation(),
      })
    })
  })

  it('escalation report generation executes through the authenticated worker boundary', async () => {
    const provider = await taskProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addEscalationInteraction(provider, MatchersV3)

    await provider.executeTest(async (mockserver) => {
      const result = await exerciseEscalation(mockserver.url)
      expect(result).toEqual({
        runId,
        reportPath: escalationReportPathExample,
        status: 'completed',
      })
    })
  })
})
