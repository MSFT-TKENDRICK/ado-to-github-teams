// Consumer-side Pact contract for the durable migration worker boundary
// (`src/worker.ts`), exercised through the real `WorkflowWorkerService` HTTP
// client (`src/workflow/client.ts`) against a Pact mock server.
//
// This suite intentionally uses one stable pacticipant name pair
// (`workerConsumerName` / `workerProviderName`, not a per-test-suffixed name)
// so every interaction below merges into a single pact file that
// `workflow-worker-provider.test.ts` provider-verifies against the real
// `src/worker.ts` application — see that file for the CI-executed
// verification of these exact interactions.
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  addApprovalInteraction,
  addElicitationInteraction,
  addEscalationReportInteraction,
  addLatestInteraction,
  addSessionsInteraction,
  addReportInteraction,
  addStartInteraction,
  addStatusInteraction,
} from './support/workflow-worker-pact.js'
import {
  apiToken,
  runId,
  sessionElicitationId,
  workerConsumerName,
  workerProviderName,
  workflowRunId,
} from './support/workflow-worker-fixtures.js'
import {
  exerciseApproval,
  exerciseElicitation,
  exerciseEscalationReport,
  exerciseLatest,
  exerciseReport,
  exerciseSessions,
  exerciseStart,
  exerciseStatus,
} from './support/workflow-worker-exercises.js'

type PactV3Type = typeof import('@pact-foundation/pact').PactV3

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

async function workerProvider(): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: workerConsumerName,
    provider: workerProviderName,
    dir: path.resolve('test/contract/pacts'),
  })
}

// `.sequential` keeps every test in this suite on the single stable
// consumer/provider pair from racing each other's mock-server ports.
contractDescribe.sequential('durable migration worker consumer contract', () => {
  it('starts a durable migration', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addStartInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      const started = await exerciseStart(mockserver.url, apiToken)
      expect(started).toEqual({runId, workflowRunId, status: 'queued'})
    })
  })

  it('reads the exact persisted plan', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addStatusInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      const status = await exerciseStatus(mockserver.url, apiToken)
      expect(status.migration?.plan.teams).toEqual([{slug: 'core', name: 'Core', kind: 'flat'}])
      expect(status.migration?.plan.memberAssignments).toEqual([{team: 'core', login: 'ada'}])
    })
  })

  it('reopens the latest durable migration', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addLatestInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      const latest = await exerciseLatest(mockserver.url, apiToken)
      expect(latest?.migration?.runId).toBe(runId)
      expect(latest?.migration?.phase).toBe('map')
    })
  })

  it('records an approval before workflow resumption', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addApprovalInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      await exerciseApproval(mockserver.url, apiToken)
    })
  })

  it('lists parallel sessions with blocking elicitations', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addSessionsInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      const sessions = await exerciseSessions(mockserver.url, apiToken)
      expect(sessions[0]?.blockingElicitations[0]?.id).toBe(sessionElicitationId)
    })
  })

  it('resolves a blocking elicitation', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addElicitationInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      await exerciseElicitation(mockserver.url, apiToken)
    })
  })

  it('downloads the completed report', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addReportInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      const report = await exerciseReport(mockserver.url, apiToken)
      expect(report).toBe('# Migration report')
    })
  })

  it('downloads the escalation dossier for an escalated migration', async () => {
    const provider = await workerProvider()
    const {MatchersV3} = await import('@pact-foundation/pact')
    addEscalationReportInteraction(provider, MatchersV3, apiToken)

    await provider.executeTest(async (mockserver) => {
      const report = await exerciseEscalationReport(mockserver.url, apiToken)
      expect(report).toBe('# Escalation dossier')
    })
  })
})
