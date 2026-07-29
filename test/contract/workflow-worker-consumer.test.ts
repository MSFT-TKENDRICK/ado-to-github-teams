import path from 'node:path'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  makeWorkflowWorkerLayer,
  WorkflowWorkerServiceTag,
} from '../../src/workflow/client.js'

type PactV3Type = typeof import('@pact-foundation/pact').PactV3

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip
const apiToken = 'test-api-token-with-at-least-32-characters'
const runId = '11111111-1111-4111-8111-111111111111'
const workflowRunId = 'workflow-run-1'
const contextFingerprint = 'a'.repeat(64)
const traceContext = {
  migrationSessionId: runId,
  workflowRunId,
  durableWorkloadTraceId: workflowRunId,
}
const applyElicitation = {
  id: `apply-${runId}`,
  runId,
  kind: 'apply-approval',
  status: 'pending',
  phase: 'dry-run',
  summary: 'Approve the exact migration plan for contoso',
  semanticSummary: 'The plan requires operator approval.',
  proposedAction: 'Apply 1 team, 1 member, and 0 repository changes.',
  allowedActions: ['approve', 'reject'],
  contextFingerprint,
  createdAt: '2026-01-01T00:00:00.000Z',
  traceId: 'trace-1',
  workItems: [
    {
      owner: 'human',
      description: 'Review the exact migration plan.',
      estimatedEffort: '5-15 minutes',
    },
  ],
}

async function workerProvider(
  testName: string,
): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: `ado-to-github-teams-cli-${testName}`,
    provider: 'durable-migration-worker',
    dir: path.resolve('test/contract/pacts'),
  })
}

function withWorker<A>(
  baseUrl: string,
  effect: Effect.Effect<A, unknown, WorkflowWorkerServiceTag>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(makeWorkflowWorkerLayer(baseUrl, apiToken))),
  )
}

contractDescribe('durable migration worker consumer contracts', () => {
  it('starts a durable migration', async () => {
    const provider = await workerProvider('start')
    provider.addInteraction({
      uponReceiving: 'a migration start request',
      withRequest: {
        method: 'POST',
        path: '/api/migrations',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: {
          runId,
          adoOrg: 'https://dev.azure.com/contoso',
          adoProject: 'Platform',
          githubOrg: 'contoso',
          apply: true,
          concurrency: 4,
          prefix: 'ado-',
        },
      },
      willRespondWith: {
        status: 202,
        headers: {'Content-Type': 'application/json'},
        body: {runId, workflowRunId, status: 'queued'},
      },
    })

    await provider.executeTest(async (mockserver) => {
      const started = await withWorker(
        mockserver.url,
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
      expect(started).toEqual({runId, workflowRunId, status: 'queued'})
    })
  })

  it('reads the exact persisted plan', async () => {
    const provider = await workerProvider('status')
    provider.addInteraction({
      uponReceiving: 'a migration status request',
      withRequest: {
        method: 'GET',
        path: `/api/migrations/${runId}`,
        headers: {authorization: 'Bearer ' + apiToken},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          workflowRunId,
          workflowStatus: 'running',
          migration: {
            runId,
            phase: 'dry-run',
            updatedAt: '2026-01-01T00:00:00.000Z',
            adoOrg: 'https://dev.azure.com/contoso',
            adoProject: 'Platform',
            githubOrg: 'contoso',
            apply: true,
            concurrency: 4,
            blocked: true,
            elicitations: [applyElicitation],
            traceContext,
            plan: {
              githubOrg: 'contoso',
              teams: [{slug: 'core', name: 'Core', kind: 'flat'}],
              memberAssignments: [{team: 'core', login: 'ada'}],
              repositoryGrants: [],
            },
            approvals: [],
          },
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      const status = await withWorker(
        mockserver.url,
        Effect.gen(function* () {
          const worker = yield* WorkflowWorkerServiceTag
          return yield* worker.status(runId)
        }),
      )
      expect(status.migration?.plan.teams).toEqual([
        {slug: 'core', name: 'Core', kind: 'flat'},
      ])
      expect(status.migration?.plan.memberAssignments).toEqual([
        {team: 'core', login: 'ada'},
      ])
    })
  })

  it('reopens the latest durable migration', async () => {
    const provider = await workerProvider('latest')
    provider.addInteraction({
      uponReceiving: 'a latest migration status request',
      withRequest: {
        method: 'GET',
        path: '/api/migrations/latest',
        headers: {authorization: 'Bearer ' + apiToken},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          workflowRunId,
          workflowStatus: 'running',
          migration: {
            runId,
            phase: 'map',
            updatedAt: '2026-01-01T00:00:00.000Z',
            adoOrg: 'https://dev.azure.com/contoso',
            adoProject: 'Platform',
            githubOrg: 'contoso',
            apply: true,
            concurrency: 4,
            blocked: false,
            elicitations: [],
            traceContext,
            plan: {
              githubOrg: 'contoso',
              teams: [],
              memberAssignments: [],
              repositoryGrants: [],
            },
            approvals: [],
          },
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      const latest = await withWorker(
        mockserver.url,
        Effect.gen(function* () {
          const worker = yield* WorkflowWorkerServiceTag
          return yield* worker.latest
        }),
      )
      expect(latest?.migration?.runId).toBe(runId)
      expect(latest?.migration?.phase).toBe('map')
    })
  })

    it('lists parallel sessions with their blocking elicitations', async () => {
      const provider = await workerProvider('sessions')
      provider.addInteraction({
        uponReceiving: 'a migration sessions inbox request',
        withRequest: {
          method: 'GET',
          path: '/api/migrations',
          headers: {authorization: 'Bearer ' + apiToken},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: [
            {
              workflowRunId,
              workflowStatus: 'running',
              migration: {
                runId,
                phase: 'dry-run',
                updatedAt: '2026-01-01T00:00:00.000Z',
                adoOrg: 'https://dev.azure.com/contoso',
                adoProject: 'Platform',
                githubOrg: 'contoso',
                apply: true,
                concurrency: 4,
                blocked: true,
                elicitations: [applyElicitation],
                traceContext,
                plan: {
                  githubOrg: 'contoso',
                  teams: [{slug: 'core', name: 'Core', kind: 'flat'}],
                  memberAssignments: [{team: 'core', login: 'ada'}],
                  repositoryGrants: [],
                },
                approvals: [],
              },
            },
          ],
        },
      })

      await provider.executeTest(async (mockserver) => {
        const sessions = await withWorker(
          mockserver.url,
          Effect.gen(function* () {
            const worker = yield* WorkflowWorkerServiceTag
            return yield* worker.sessions
          }),
        )
        expect(sessions[0]?.migration?.blocked).toBe(true)
        expect(sessions[0]?.migration?.elicitations[0]?.id).toBe(
          applyElicitation.id,
        )
      })
    })

    it('answers an elicitation with its captured fingerprint', async () => {
      const provider = await workerProvider('elicitation-answer')
      provider.addInteraction({
        uponReceiving: 'a fingerprint-bound elicitation answer',
        withRequest: {
          method: 'POST',
          path: `/api/migrations/${runId}/elicitations/${applyElicitation.id}`,
          headers: {
            authorization: 'Bearer ' + apiToken,
            'content-type': 'application/json',
          },
          body: {
            elicitationId: applyElicitation.id,
            expectedFingerprint: contextFingerprint,
            answerId: 'answer-1',
            action: 'approve',
            answeredBy: 'operator@example.com',
          },
        },
        willRespondWith: {
          status: 202,
          headers: {'Content-Type': 'application/json'},
          body: {
            runId,
            elicitationId: applyElicitation.id,
            accepted: true,
          },
        },
      })

      await provider.executeTest(async (mockserver) => {
        await withWorker(
          mockserver.url,
          Effect.gen(function* () {
            const worker = yield* WorkflowWorkerServiceTag
            yield* worker.answerElicitation(runId, {
              elicitationId: applyElicitation.id,
              expectedFingerprint: contextFingerprint,
              answerId: 'answer-1',
              action: 'approve',
              answeredBy: 'operator@example.com',
            })
          }),
        )
      })
    })

  it('records an approval before workflow resumption', async () => {
    const provider = await workerProvider('approval')
    provider.addInteraction({
      uponReceiving: 'an approval submission',
      withRequest: {
        method: 'POST',
        path: `/api/migrations/${runId}/approval`,
        headers: {
          authorization: 'Bearer ' + apiToken,
          'content-type': 'application/json',
        },
        body: {
          approved: true,
          approvedBy: 'operator@example.com',
          comment: 'Reviewed exact plan',
        },
      },
      willRespondWith: {
        status: 202,
        headers: {'Content-Type': 'application/json'},
        body: {runId, accepted: true},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await withWorker(
        mockserver.url,
        Effect.gen(function* () {
          const worker = yield* WorkflowWorkerServiceTag
          yield* worker.approve(runId, {
            approved: true,
            approvedBy: 'operator@example.com',
            comment: 'Reviewed exact plan',
          })
        }),
      )
    })
  })

  it('downloads the completed report', async () => {
    const provider = await workerProvider('report')
    provider.addInteraction({
      uponReceiving: 'a migration report request',
      withRequest: {
        method: 'GET',
        path: `/api/migrations/${runId}/report`,
        headers: {authorization: `Bearer ${apiToken}`},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'text/markdown'},
        body: '# Migration report',
      },
    })

    await provider.executeTest(async (mockserver) => {
      const report = await withWorker(
        mockserver.url,
        Effect.gen(function* () {
          const worker = yield* WorkflowWorkerServiceTag
          return yield* worker.report(runId)
        }),
      )
      expect(report).toBe('# Migration report')
    })
  })
})
