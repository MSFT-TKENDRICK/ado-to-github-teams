// Real provider verification for the durable-migration-worker Pact contract.
//
// Unlike the consumer test, this file boots the ACTUAL `src/worker.ts` Express
// application (see support/worker-app.ts) and runs Pact's `Verifier` against
// it. Only two external orchestration boundaries this repository does not own
// are mocked (see worker-app.ts for why); everything else — routing, auth
// middleware, schema decode/encode, and the checkpoint sqlite store — is real.
//
// Provider states are backed by real `CheckpointManager` writes so the
// application under test never needs its mocked `workflow/api.start()` to be
// reached; that mock throws if it ever is, acting as a canary against a
// mis-specified provider state.
//
// Audit item 7 (the gate must not silently pass with zero provider
// verifications): this test asserts the recorded pact file actually contains
// every interaction defined for this boundary before verifying, so a broken
// recording step (e.g. an interaction silently failing to register) fails the
// build instead of letting Verifier report a vacuous, always-green result.
import {readFile, readdir, writeFile} from 'node:fs/promises'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import type {ElicitationResolution} from '../../src/types/index.js'
import {bootWorkerApp, type WorkerAppHandle} from './support/worker-app.js'
import {
  addApprovalInteraction,
  addElicitationInteraction,
  addEscalationReportInteraction,
  addLatestInteraction,
  addSessionsInteraction,
  addReportInteraction,
  addStartInteraction,
  addStatusInteraction,
  workflowWorkerProviderStates,
} from './support/workflow-worker-pact.js'
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
import {
  blockingElicitation,
  blockedSessionCheckpoint,
  latestCheckpoint,
  runId,
  sessionBlockingElicitation,
  statusCheckpoint,
  workerConsumerName,
  workerProviderName,
  workflowRunId,
} from './support/workflow-worker-fixtures.js'

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

const recordedInteractions: ReadonlyArray<{
  readonly add: typeof addStartInteraction
  readonly exercise: (baseUrl: string, apiToken: string) => Promise<unknown>
}> = [
  {add: addStartInteraction, exercise: exerciseStart},
  {add: addStatusInteraction, exercise: exerciseStatus},
  {add: addLatestInteraction, exercise: exerciseLatest},
  {add: addApprovalInteraction, exercise: exerciseApproval},
  {add: addSessionsInteraction, exercise: exerciseSessions},
  {add: addElicitationInteraction, exercise: exerciseElicitation},
  {add: addReportInteraction, exercise: exerciseReport},
  {add: addEscalationReportInteraction, exercise: exerciseEscalationReport},
]

/**
 * Preference order for auto-resolving elicitations left pending by a prior
 * interaction: `skip` is the least disruptive way to unblock a run, `abort`
 * is the next safest fallback, and `retry` is the last resort since it can
 * re-trigger the original failure. `resolveElicitation` rejects any action
 * not present in the elicitation's own `choices`, so this must always pick
 * one the elicitation actually supports rather than assuming `skip`.
 */
const RESOLUTION_PREFERENCE: readonly ElicitationResolution[] = ['skip', 'abort', 'retry']

function selectSupportedResolution(
  choices: readonly ElicitationResolution[],
): ElicitationResolution {
  const selected = RESOLUTION_PREFERENCE.find((candidate) => choices.includes(candidate))
  if (selected === undefined) {
    throw new Error(
      `No supported elicitation resolution among [${RESOLUTION_PREFERENCE.join(', ')}] ` +
        `was found in choices: ${choices.join(', ') || '(none)'}`,
    )
  }
  return selected
}

/**
 * Provider states must each fully configure the state they claim, independent
 * of execution order (see Pact's provider-state guidance) — Verifier does not
 * guarantee interactions run in declaration order. `blockedSessions` and
 * `pendingElicitation` persist pending elicitations against the shared fixture
 * `runId`; without this, whichever of `statusPlan`/`latestPlan` happens to run
 * after them would see stale `blockingElicitations` and an incorrectly
 * derived `workflowStatus: 'blocked'` (see worker.ts's status handlers).
 */
async function clearPendingElicitations(handle: WorkerAppHandle): Promise<void> {
  const pending = await handle.checkpointManager.listElicitations(runId, 'pending')
  for (const elicitation of pending) {
    await handle.checkpointManager.resolveElicitation(elicitation.id, {
      action: selectSupportedResolution(elicitation.choices),
      decidedBy: 'contract-test-cleanup',
    })
  }
}

/**
 * Records every worker-boundary interaction into `dir` as a single merged
 * pact file, by driving each one through a real PactV3 mock server (the only
 * way this library persists an interaction — see PactV3#executeTest). Returns
 * the absolute path to the resulting pact JSON file.
 */
async function recordWorkerPact(dir: string, apiToken: string): Promise<string> {
  const {PactV3, MatchersV3} = await import('@pact-foundation/pact')
  for (const {add, exercise} of recordedInteractions) {
    const provider = new PactV3({
      consumer: workerConsumerName,
      provider: workerProviderName,
      dir,
    })
    add(provider, MatchersV3, apiToken)
    await provider.executeTest(async (mockserver) => {
      await exercise(mockserver.url, apiToken)
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

contractDescribe('durable migration worker provider verification', () => {
  let handle: WorkerAppHandle

  beforeAll(async () => {
    handle = await bootWorkerApp()
  }, 30_000)

  afterAll(async () => {
    await handle.close()
  })

  it('verifies every recorded worker interaction against the real app', async () => {
    const pactDir = await mkdtemp(path.join(tmpdir(), 'worker-pact-'))
    const pactFilePath = await recordWorkerPact(pactDir, handle.apiToken)

    const pactFile = JSON.parse(await readFile(pactFilePath, 'utf8')) as {
      interactions: unknown[]
    }
    // Anti-tautology guard (audit item 7): the whole point of this test is to
    // provider-verify a non-empty, non-trivial set of interactions. If the
    // recording step above ever regresses to producing zero (or fewer than
    // expected) interactions, fail loudly here instead of letting Verifier
    // report a vacuous "0 interactions, 0 failures" success.
    expect(pactFile.interactions.length).toBe(recordedInteractions.length)

    const reportPath = path.join(handle.reportDirectory, `migration-report-${runId}.md`)
    const escalationReportPath = path.join(
      handle.reportDirectory,
      `migration-escalation-${runId}.md`,
    )

    const {Verifier} = await import('@pact-foundation/pact')
    const verifier = new Verifier({
      provider: workerProviderName,
      providerBaseUrl: handle.baseUrl,
      pactUrls: [pactFilePath],
      logLevel: 'warn',
      stateHandlers: {
        [workflowWorkerProviderStates.started]: async () => {
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:00:00.000Z',
          })
        },
        [workflowWorkerProviderStates.statusPlan]: async () => {
          await clearPendingElicitations(handle)
          await handle.checkpointManager.save(statusCheckpoint())
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:00:00.000Z',
          })
          handle.setRunStatus('running')
        },
        [workflowWorkerProviderStates.latestPlan]: async () => {
          await clearPendingElicitations(handle)
          await handle.checkpointManager.save(latestCheckpoint())
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:00:00.000Z',
          })
          handle.setRunStatus('running')
        },
        [workflowWorkerProviderStates.approvable]: async () => {
          await handle.checkpointManager.save(statusCheckpoint())
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:00:00.000Z',
          })
        },
        [workflowWorkerProviderStates.blockedSessions]: async () => {
          await clearPendingElicitations(handle)
          await handle.checkpointManager.save(blockedSessionCheckpoint())
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:01:00.000Z',
          })
          await handle.checkpointManager.createElicitation(sessionBlockingElicitation)
        },
        [workflowWorkerProviderStates.pendingElicitation]: async () => {
          await clearPendingElicitations(handle)
          await handle.checkpointManager.save(blockedSessionCheckpoint())
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:01:00.000Z',
          })
          await handle.checkpointManager.createElicitation(blockingElicitation)
        },
        [workflowWorkerProviderStates.reportAvailable]: async () => {
          await handle.checkpointManager.save(statusCheckpoint())
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:00:00.000Z',
          })
          await writeFile(reportPath, '# Migration report', 'utf8')
          await handle.checkpointManager.recordWorkflowOutcome(
            runId,
            'completed',
            reportPath,
            'migration',
          )
        },
        [workflowWorkerProviderStates.escalationReportAvailable]: async () => {
          await handle.checkpointManager.save(statusCheckpoint())
          await handle.checkpointManager.linkWorkflow({
            migrationRunId: runId,
            workflowRunId,
            createdAt: '2026-01-01T00:00:00.000Z',
          })
          await writeFile(escalationReportPath, '# Escalation dossier', 'utf8')
          await handle.checkpointManager.recordWorkflowOutcome(
            runId,
            'escalated',
            escalationReportPath,
            'escalation',
          )
        },
      },
      requestFilter: (request, _response, next) => {
        request.headers.authorization = ['Bearer', handle.apiToken].join(' ')
        next()
      },
    })

    await expect(verifier.verifyProvider()).resolves.toBeTypeOf('string')
  }, 60_000)
})

describe('selectSupportedResolution', () => {
  it('prefers skip when it is among the elicitation choices', () => {
    expect(selectSupportedResolution(['retry', 'skip', 'abort'])).toBe('skip')
  })

  it('falls back to abort when skip is not a supported choice', () => {
    expect(selectSupportedResolution(['retry', 'abort'])).toBe('abort')
  })

  it('falls back to retry when it is the only supported choice', () => {
    expect(selectSupportedResolution(['retry'])).toBe('retry')
  })

  it('throws a clear error when no supported action is available', () => {
    expect(() => selectSupportedResolution([])).toThrow(
      /No supported elicitation resolution among \[skip, abort, retry\] was found in choices: \(none\)/,
    )
  })
})
