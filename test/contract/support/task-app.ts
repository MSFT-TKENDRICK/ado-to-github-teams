// Shared bootstrap for provider-verifying the real `src/worker.ts` Express app
// against the `durable-migration-worker-internal-api` (task-callback) Pact
// contract. This mirrors support/worker-app.ts's approach (boot the actual
// app in-process against a temp sqlite store) but additionally replaces
// `executeMigration` — the entry point into the real ADO/GitHub/Entra/Copilot
// Effect pipeline (src/workflow/step-runtime.ts) — with a deterministic stub.
// That pipeline is exercised by its own dedicated unit/integration tests
// elsewhere; re-running it here would require live Azure/GitHub credentials
// and network access, which a contract test must not depend on. Everything
// else on the request path — Express routing, the `requireTaskToken` HMAC
// auth middleware, request/response schema encode/decode, and `linkWorkflow`
// against a real (temp-file-backed) `CheckpointManager` — is real.
//
// vi.mock calls are hoisted to the top of *this* file by Vitest's static
// transform, so importing this module before the app is (lazily) imported
// registers the mocks first.
import {mkdir, rm} from 'node:fs/promises'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import type {AddressInfo} from 'node:net'
import {vi} from 'vitest'
import type {World} from '@workflow/world'
import type {MigrationTaskResult} from '../../../src/workflow/contracts.js'

export const executeMigrationMock = vi.fn(
  async (input: {runId: string; output?: string}): Promise<MigrationTaskResult> => ({
    runId: input.runId,
    reportPath: input.output ?? `/data/reports/migration-report-${input.runId}.md`,
    status: 'completed',
  }),
)

vi.mock('../../../src/workflow/step-runtime.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/workflow/step-runtime.js')>()
  return {
    ...actual,
    executeMigration: executeMigrationMock,
  }
})

vi.mock('workflow/api', () => ({
  start: vi.fn(async () => {
    throw new Error('workflow/api.start() is not exercised by the task contract.')
  }),
  getRun: vi.fn(() => {
    throw new Error('workflow/api.getRun() is not exercised by the task contract.')
  }),
  resumeHook: vi.fn(async () => {
    throw new Error('workflow/api.resumeHook() is not exercised by the task contract.')
  }),
  getHookByToken: vi.fn(async () => {
    throw new Error(
      'workflow/api.getHookByToken() is not exercised by the task contract.',
    )
  }),
  resumeWebhook: vi.fn(async () => {
    throw new Error(
      'workflow/api.resumeWebhook() is not exercised by the task contract.',
    )
  }),
  runStep: vi.fn(),
}))

vi.mock('../../../src/workflow/world.js', () => ({
  createDurableLocalWorld: () =>
    ({
      start: async () => undefined,
    }) as unknown as World,
}))

export const taskApiToken = 'test-api-token-with-at-least-32-characters'
export const taskSecret = 'test-task-secret-with-at-least-32-characters-'

export interface TaskAppHandle {
  readonly baseUrl: string
  readonly taskSecret: string
  close(): Promise<void>
}

export async function bootTaskApp(): Promise<TaskAppHandle> {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-provider-'))
  const sqlitePath = path.join(directory, 'workflow.db')
  const reportDirectory = path.join(directory, 'reports')
  await mkdir(reportDirectory, {recursive: true})

  process.env.WORKFLOW_API_TOKEN = taskApiToken
  process.env.WORKFLOW_TASK_SECRET = taskSecret
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

  return {
    baseUrl,
    taskSecret,
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
