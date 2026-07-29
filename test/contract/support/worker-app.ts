// Shared bootstrap for provider-verifying the real `src/worker.ts` Express app.
//
// This harness boots the actual application module (not a stand-in) so that
// provider verification exercises real Express routing, real auth middleware,
// real request/response schema encode/decode, and a real (temp-file-backed)
// `CheckpointManager`/sqlite store. Two boundaries this repository does not own
// are mocked at the module edge, per AGENTS.md's adapter-isolation rule:
//
// - `workflow/api` — the `workflow` orchestration SDK (`getRun`/`start`/
//   `resumeHook`). Provider states are designed so real routes never need to
//   reach into a live orchestration engine (see workflow-worker-pact.ts).
// - `../../../src/workflow/world.js` — `createDurableLocalWorld`, which in
//   production wires up real NATS + Turso. Booting those for a deterministic,
//   CI-safe contract test is not practical, so the World is replaced with a
//   minimal fake that only satisfies the module-level `world.start()` call.
//
// vi.mock calls are hoisted to the top of *this* file by Vitest's static
// transform, so importing this module before the app is (lazily) imported
// registers both mocks first.
import {mkdir, rm} from 'node:fs/promises'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import type {AddressInfo} from 'node:net'
import {vi} from 'vitest'
import type {World} from '@workflow/world'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import {apiToken as fixtureApiToken} from './workflow-worker-fixtures.js'

const getRunStatus = vi.fn(async (_runId: string) => 'running')

export const workflowApiMock = {
  start: vi.fn(async () => {
    throw new Error(
      'workflow/api.start() was reached during provider verification. Every ' +
        'verified interaction is expected to hit a state where the run is ' +
        'already linked, so start() should never be called; add or fix the ' +
        'provider state instead of relying on the live orchestration engine.',
    )
  }),
  getRun: vi.fn((runId: string) => ({
    runId,
    get status() {
      return getRunStatus(runId)
    },
  })),
  resumeHook: vi.fn(async (token: string) => ({
    runId: 'mock-run',
    token,
  })),
  getHookByToken: vi.fn(async () => {
    throw new Error('getHookByToken is not exercised by the worker contract.')
  }),
  resumeWebhook: vi.fn(async () => {
    throw new Error('resumeWebhook is not exercised by the worker contract.')
  }),
  runStep: vi.fn(),
}
vi.mock('workflow/api', () => workflowApiMock)

vi.mock('../../../src/workflow/world.js', () => ({
  createDurableLocalWorld: () =>
    ({
      start: async () => undefined,
    }) as unknown as World,
}))

export const workerApiToken = fixtureApiToken
export const workerTaskSecret = 'test-task-secret-with-at-least-32-characters-'

export interface WorkerAppHandle {
  readonly baseUrl: string
  readonly checkpointManager: CheckpointManager
  readonly apiToken: string
  readonly taskSecret: string
  readonly reportDirectory: string
  /** Overrides the workflow run status the mocked `getRun(...).status` resolves to. */
  setRunStatus(status: string): void
  close(): Promise<void>
}

export async function bootWorkerApp(): Promise<WorkerAppHandle> {
  const directory = await mkdtemp(path.join(tmpdir(), 'worker-provider-'))
  const sqlitePath = path.join(directory, 'workflow.db')
  const reportDirectory = path.join(directory, 'reports')
  await mkdir(reportDirectory, {recursive: true})

  process.env.WORKFLOW_API_TOKEN = workerApiToken
  process.env.WORKFLOW_TASK_SECRET = workerTaskSecret
  process.env.WORKFLOW_SQLITE_PATH = sqlitePath
  process.env.WORKFLOW_REPORT_DIR = reportDirectory
  process.env.WORKFLOW_TARGET_WORLD = 'local'
  delete process.env.WORKFLOW_ALLOW_REMOTE_TARGET

  const {default: app} = await import('../../../src/worker.js')
  const server = app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const address = server.address() as AddressInfo | null
  if (!address) {
    throw new Error('Worker HTTP server did not bind to a port.')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  const checkpointManager = new CheckpointManager(sqlitePath)

  return {
    baseUrl,
    checkpointManager,
    apiToken: workerApiToken,
    taskSecret: workerTaskSecret,
    reportDirectory,
    setRunStatus: (status: string) => {
      getRunStatus.mockImplementation(async () => status)
    },
    async close() {
      const {closeWorld} = await import('../../../src/worker.js')
      await closeWorld()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await rm(directory, {recursive: true, force: true})
    },
  }
}
