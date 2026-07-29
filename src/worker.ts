import path from 'node:path'
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import {getRun, start} from 'workflow/api'
import {
  createWorld as createSelectedWorld,
  setWorld,
} from 'workflow/runtime'
import type {World} from '@workflow/world'
import {migrationWorkflow} from './workflow/migration.js'
import {CheckpointManager} from './checkpoints/manager.js'
import {
  approvalToken,
} from './workflow/contracts.js'
import {
  decodeApprovalDecision,
  decodeMigrationWorkflowInput,
} from './workflow/schemas.js'
import {resolveWorldRuntimeConfig} from './workflow/config.js'
import {createDurableLocalWorld} from './workflow/world.js'
import {
  executeMigration,
  linkWorkflowRun,
} from './workflow/step-runtime.js'
import {persistThenResumeApproval} from './workflow/approval-runtime.js'
import {
  createTaskToken,
  verifyOpaqueToken,
  verifyTaskToken,
} from './workflow/security.js'

const config = resolveWorldRuntimeConfig()
const world: World =
  config.mode === 'local'
    ? createDurableLocalWorld(config)
    : createSelectedWorld()
setWorld(world)
let worldIsReady = false
let worldStartupError: unknown
const worldReady = Promise.resolve(world.start?.()).then(
  () => {
    worldIsReady = true
  },
  (error: unknown) => {
    worldStartupError = error
    throw error
  },
)

function requiredSecret(name: string, minimumLength: number): string {
  const value = process.env[name]
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} characters.`)
  }
  return value
}

const apiToken = requiredSecret('WORKFLOW_API_TOKEN', 32)
const taskSecret = requiredSecret('WORKFLOW_TASK_SECRET', 32)
const migrationRunIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const checkpointManager = new CheckpointManager(
  process.env.WORKFLOW_SQLITE_PATH,
)
const reportDirectory =
  process.env.WORKFLOW_REPORT_DIR ??
  path.join(path.dirname(process.env.WORKFLOW_SQLITE_PATH ?? ''), 'reports')

function bearerToken(request: Request): string {
  const authorization = request.header('authorization')
  return authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
}

function runIdParameter(request: Request): string {
  const runId = request.params.runId
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('A migration run ID is required.')
  }
  return runId
}

function requireApiToken(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!verifyOpaqueToken(apiToken, bearerToken(request))) {
    response.status(401).json({error: 'Unauthorized'})
    return
  }
  next()
}

function requireTaskToken(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const runId = runIdParameter(request)
  if (!verifyTaskToken(taskSecret, runId, bearerToken(request))) {
    response.status(401).json({error: 'Unauthorized workflow task'})
    return
  }
  next()
}

function migrationStatus(state: Awaited<ReturnType<CheckpointManager['load']>>) {
  if (!state) {
    return null
  }
  return {
    runId: state.runId,
    phase: state.phase,
    updatedAt: state.timestamp,
    plan: {
      githubOrg: state.githubOrg,
      teams: state.mappings.map((mapping) => ({
        slug: mapping.githubTeam.slug,
        name: mapping.githubTeam.name,
      })),
      memberAssignments: state.mappings.flatMap((mapping) =>
        mapping.memberMappings
          .filter((member) => member.mapped && member.githubUser)
          .map((member) => ({
            team: mapping.githubTeam.slug,
            login: member.githubUser?.login ?? '',
          })),
      ),
    },
    approvals: state.approvalHistory,
  }
}

const app: Express = express()
app.get('/health', (_request, response) => {
  if (worldStartupError) {
    response.status(503).json({status: 'failed', world: config.mode})
    return
  }
  if (!worldIsReady) {
    response.status(503).json({status: 'starting', world: config.mode})
    return
  }
  response.json({status: 'ok', world: config.mode})
})
app.use((_request, _response, next) => {
  void worldReady.then(() => next(), next)
})
app.use(express.json({limit: '1mb'}))

app.post('/api/migrations', requireApiToken, async (request, response) => {
  const body = request.body as unknown
  if (
    typeof body !== 'object' ||
    body === null ||
    !('runId' in body) ||
    typeof body.runId !== 'string' ||
    !migrationRunIdPattern.test(body.runId)
  ) {
    response.status(400).json({error: 'A valid migration run ID is required'})
    return
  }
  const runId = body.runId
  const input = decodeMigrationWorkflowInput({
    ...body,
    workerBaseUrl:
      process.env.WORKFLOW_INTERNAL_BASE_URL ??
      (config.mode === 'local' ? config.baseUrl : process.env.WORKFLOW_BASE_URL),
    taskToken: createTaskToken(taskSecret, runId),
    output: path.join(
      reportDirectory,
      `migration-report-${runId}.md`,
    ),
  })
  const existingWorkflowRunId =
    await checkpointManager.getWorkflowRunId(runId)
  if (existingWorkflowRunId) {
    response.status(202).json({
      runId,
      workflowRunId: existingWorkflowRunId,
      status: 'queued',
    })
    return
  }
  const workflowRun = await start(migrationWorkflow, [input], {world})
  await checkpointManager.linkWorkflow({
    migrationRunId: runId,
    workflowRunId: workflowRun.runId,
    createdAt: new Date().toISOString(),
  })
  response.status(202).json({
    runId,
    workflowRunId: workflowRun.runId,
    status: 'queued',
  })
})

app.get('/api/migrations/:runId', requireApiToken, async (request, response) => {
  const runId = runIdParameter(request)
  const workflowRunId = await checkpointManager.getWorkflowRunId(runId)
  if (!workflowRunId) {
    response.status(404).json({error: 'Migration not found'})
    return
  }
  const state = await checkpointManager.load(runId)
  response.json({
    workflowRunId,
    workflowStatus: await getRun(workflowRunId).status,
    migration: migrationStatus(state),
  })
})

app.post(
  '/api/migrations/:runId/approval',
  requireApiToken,
  async (request, response) => {
    const runId = runIdParameter(request)
    const decision = decodeApprovalDecision(request.body)
    await persistThenResumeApproval(
      runId,
      approvalToken(runId),
      decision,
    )
    response.status(202).json({runId, accepted: true})
  },
)

app.get(
  '/api/migrations/:runId/report',
  requireApiToken,
  async (request, response) => {
    const state = await checkpointManager.load(runIdParameter(request))
    if (!state) {
      response.status(404).json({error: 'Migration not found'})
      return
    }
    response.sendFile(
      path.resolve(reportDirectory, `migration-report-${state.runId}.md`),
    )
  },
)

app.post(
  '/internal/migrations/:runId/prepare',
  requireTaskToken,
  async (request, response) => {
    const runId = runIdParameter(request)
    const input = decodeMigrationWorkflowInput(request.body)
    if (input.runId !== runId) {
      response.status(409).json({error: 'Migration run ID mismatch'})
      return
    }
    if (!input.workflowRunId) {
      response.status(409).json({error: 'Workflow run ID is required'})
      return
    }
    await linkWorkflowRun(runId, input.workflowRunId)
    response.json(await executeMigration(input, false))
  },
)

app.post(
  '/internal/migrations/:runId/apply',
  requireTaskToken,
  async (request, response) => {
    const runId = runIdParameter(request)
    const input = decodeMigrationWorkflowInput(request.body)
    if (input.runId !== runId) {
      response.status(409).json({error: 'Migration run ID mismatch'})
      return
    }
    if (!input.workflowRunId) {
      response.status(409).json({error: 'Workflow run ID is required'})
      return
    }
    await linkWorkflowRun(runId, input.workflowRunId)
    response.json(await executeMigration(input, true))
  },
)

const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  next,
) => {
  void next
  const message = error instanceof Error ? error.message : String(error)
  response.status(500).json({error: message})
}
app.use(errorHandler)

export async function closeWorld(): Promise<void> {
  await worldReady
  await world.close?.()
}

export default app
