// Real provider verification for the durable-migration-worker-internal-api
// (task-callback) Pact contract.
//
// Unlike the consumer test, this file boots the ACTUAL `src/worker.ts`
// Express application (see support/task-app.ts) and runs Pact's `Verifier`
// against it. `executeMigration` (the entry point into the real
// ADO/GitHub/Entra/Copilot Effect pipeline) is mocked — see task-app.ts for
// why — but Express routing, the `requireTaskToken` HMAC auth middleware
// (exercised for real via requestFilter below), request/response schema
// encode/decode, and `linkWorkflow` against a real checkpoint store are all
// real. The escalation endpoint additionally exercises its own real
// (unmocked) checkpoint + elicitation lookup and report-writing logic — see
// the `escalationReady` state handler below.
//
// Audit item 7 (the gate must not silently pass with zero provider
// verifications): this test asserts the recorded pact file actually contains
// every interaction defined for this boundary before verifying, so a broken
// recording step fails the build instead of letting Verifier report a
// vacuous, always-green result.
import {readFile, readdir} from 'node:fs/promises'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {bootTaskApp, executeMigrationMock, type TaskAppHandle} from './support/task-app.js'
import {
  addApplyBlockedInteraction,
  addApplyInProgressInteraction,
  addApplyInteraction,
  addEscalationInteraction,
  addPrepareInteraction,
  workflowTaskProviderStates,
} from './support/workflow-task-pact.js'
import {
  exerciseApply,
  exerciseEscalation,
  exercisePrepare,
} from './support/workflow-task-exercises.js'
import {
  escalationCheckpoint,
  escalationElicitation,
  reportPath,
  taskConsumerName,
  taskProviderName,
} from './support/workflow-task-fixtures.js'
import {createTaskToken, type TaskTokenStep} from '../../src/workflow/security.js'

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

const recordedInteractions: ReadonlyArray<{
  readonly add: typeof addPrepareInteraction
  readonly exercise: (baseUrl: string) => Promise<unknown>
}> = [
  {add: addPrepareInteraction, exercise: exercisePrepare},
  {add: addApplyInteraction, exercise: exerciseApply},
  {add: addApplyInProgressInteraction, exercise: exerciseApply},
  {add: addApplyBlockedInteraction, exercise: exerciseApply},
  {add: addEscalationInteraction, exercise: exerciseEscalation},
]

/**
 * Records every task-boundary interaction into `dir` as a single merged pact
 * file, by driving each one through a real PactV3 mock server (the only way
 * this library persists an interaction — see PactV3#executeTest). Returns the
 * absolute path to the resulting pact JSON file.
 */
async function recordTaskPact(dir: string): Promise<string> {
  const {PactV3, MatchersV3} = await import('@pact-foundation/pact')
  for (const {add, exercise} of recordedInteractions) {
    const provider = new PactV3({
      consumer: taskConsumerName,
      provider: taskProviderName,
      dir,
    })
    add(provider, MatchersV3)
    await provider.executeTest(async (mockserver) => {
      await exercise(mockserver.url)
    })
  }
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json'))
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one recorded pact file in ${dir}, found: ${files.join(', ') || '(none)'}`,
    )
  }
  return path.join(dir, files[0]!)
}

/**
 * Extracts the `:runId` and step (`prepare`/`apply`/`escalation`) path
 * segments from a task-callback request. The Pact verification proxy mounts
 * `requestFilter` as an unparameterized global middleware (see
 * @pact-foundation/pact's proxy.js), so `request.params` is never populated
 * with Express route params here — both the run ID and the step have to be
 * parsed out of the raw path instead. The step is required to mint a
 * correctly-scoped token (see `createTaskToken`'s per-step HMAC binding in
 * security.ts).
 */
function taskRequestFromPath(
  requestPath: string,
): {readonly runId: string; readonly step: TaskTokenStep} | undefined {
  const match = /^\/internal\/migrations\/([^/]+)\/(prepare|apply|escalation)$/.exec(requestPath)
  const runId = match?.[1]
  const step = match?.[2]
  if (!runId || (step !== 'prepare' && step !== 'apply' && step !== 'escalation')) {
    return undefined
  }
  return {runId, step}
}

contractDescribe('workflow task worker provider verification', () => {
  let handle: TaskAppHandle

  beforeAll(async () => {
    handle = await bootTaskApp()
  }, 30_000)

  afterAll(async () => {
    await handle.close()
  })

  it('verifies every recorded task interaction against the real app', async () => {
    const pactDir = await mkdtemp(path.join(tmpdir(), 'task-pact-'))
    const pactFilePath = await recordTaskPact(pactDir)

    const pactFile = JSON.parse(await readFile(pactFilePath, 'utf8')) as {
      interactions: unknown[]
    }
    // Anti-tautology guard (audit item 7): fail loudly if the recording step
    // above ever regresses to producing zero (or fewer than expected)
    // interactions, instead of letting Verifier report a vacuous "0
    // interactions, 0 failures" success.
    expect(pactFile.interactions.length).toBe(recordedInteractions.length)

    const {Verifier} = await import('@pact-foundation/pact')
    const verifier = new Verifier({
      provider: taskProviderName,
      providerBaseUrl: handle.baseUrl,
      pactUrls: [pactFilePath],
      logLevel: 'warn',
      stateHandlers: {
        // executeMigration is mocked (see task-app.ts). Every state below
        // that drives a prepare/apply interaction queues its own explicit
        // `mockImplementationOnce` rather than relying on the mock's shared
        // default return value - Pact's Verifier does not guarantee the
        // order interactions run in, so each state must independently and
        // fully configure its own next-call behavior (the same isolation
        // fix applied to the worker-boundary provider states after the
        // elicitation-leakage bug found earlier in this project).
        [workflowTaskProviderStates.prepareReady]: async () => {
          executeMigrationMock.mockImplementationOnce(async (input) => ({
            runId: input.runId,
            reportPath: input.output ?? reportPath,
            status: 'completed',
          }))
        },
        [workflowTaskProviderStates.applyReady]: async () => {
          executeMigrationMock.mockImplementationOnce(async (input) => ({
            runId: input.runId,
            reportPath: input.output ?? reportPath,
            status: 'completed',
          }))
        },
        // PR #26 (durable workflow recovery) made MigrationTaskResult a
        // discriminated union with two additional variants beyond
        // 'completed' - see workflow-task-pact.ts's addApplyInProgressInteraction
        // and addApplyBlockedInteraction doc comments for when the real
        // executeMigration produces each one.
        [workflowTaskProviderStates.applyInProgress]: async () => {
          executeMigrationMock.mockImplementationOnce(async (input) => ({
            runId: input.runId,
            reportPath: input.output ?? reportPath,
            status: 'in-progress',
          }))
        },
        [workflowTaskProviderStates.applyBlocked]: async () => {
          executeMigrationMock.mockImplementationOnce(async (input) => ({
            runId: input.runId,
            reportPath: input.output ?? reportPath,
            status: 'needs-elicitation',
            elicitation: escalationElicitation(),
          }))
        },
        // The escalation handler is NOT mocked (see task-app.ts) - it does
        // real CheckpointManager/escalationReporter work, so this state must
        // seed real, matching checkpoint + elicitation records before the
        // interaction runs, or the real handler's own
        // checkpointManager.load(runId)/getElicitation(elicitationId) lookups
        // would 404/500 rather than actually exercising the report-writing
        // path.
        [workflowTaskProviderStates.escalationReady]: async () => {
          await handle.checkpointManager.save(escalationCheckpoint())
          await handle.checkpointManager.createElicitation(escalationElicitation())
        },
      },
      requestFilter: (request, _response, next) => {
        const parsed = taskRequestFromPath(request.path)
        if (parsed) {
          request.headers.authorization = [
            'Bearer',
            createTaskToken(handle.taskSecret, parsed.runId, parsed.step),
          ].join(' ')
        }
        next()
      },
    })

    await expect(verifier.verifyProvider()).resolves.toBeTypeOf('string')
  }, 60_000)
})
