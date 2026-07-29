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
// real.
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
import {bootTaskApp, type TaskAppHandle} from './support/task-app.js'
import {
  addApplyInteraction,
  addPrepareInteraction,
  workflowTaskProviderStates,
} from './support/workflow-task-pact.js'
import {exerciseApply, exercisePrepare} from './support/workflow-task-exercises.js'
import {taskConsumerName, taskProviderName} from './support/workflow-task-fixtures.js'
import {createTaskToken} from '../../src/workflow/security.js'

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

const recordedInteractions: ReadonlyArray<{
  readonly add: typeof addPrepareInteraction
  readonly exercise: (baseUrl: string) => Promise<unknown>
}> = [
  {add: addPrepareInteraction, exercise: exercisePrepare},
  {add: addApplyInteraction, exercise: exerciseApply},
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
 * Extracts the `:runId` path segment from a task-callback request. The Pact
 * verification proxy mounts `requestFilter` as an unparameterized global
 * middleware (see @pact-foundation/pact's proxy.js), so `request.params` is
 * never populated with Express route params here — the run ID has to be
 * parsed out of the raw path instead.
 */
function runIdFromPath(requestPath: string): string | undefined {
  return /^\/internal\/migrations\/([^/]+)\/(?:prepare|apply)$/.exec(requestPath)?.[1]
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
        // executeMigration is mocked (see task-app.ts), so neither state
        // needs to seed checkpoint data — both exist purely as documentation
        // of the precondition each interaction represents.
        [workflowTaskProviderStates.prepareReady]: async () => {},
        [workflowTaskProviderStates.applyReady]: async () => {},
      },
      requestFilter: (request, _response, next) => {
        const runId = runIdFromPath(request.path)
        if (runId) {
          request.headers.authorization = [
            'Bearer',
            createTaskToken(handle.taskSecret, runId),
          ].join(' ')
        }
        next()
      },
    })

    await expect(verifier.verifyProvider()).resolves.toBeTypeOf('string')
  }, 60_000)
})
