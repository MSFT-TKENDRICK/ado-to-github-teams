import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import {getRun, start} from 'workflow/api'
import {createWorld as createSelectedWorld, setWorld} from 'workflow/runtime'
import type {World} from '@workflow/world'
import {migrationWorkflow} from './workflow/migration.js'
import {CheckpointManager} from './checkpoints/manager.js'
import {EscalationReporter} from './reporters/escalation.js'
import {approvalToken} from './workflow/contracts.js'
import {
  decodeApprovalDecision,
  decodeElicitationDecision,
  decodeMigrationWorkflowInput,
} from './workflow/schemas.js'
import {resolveWorldRuntimeConfig} from './workflow/config.js'
import {createDurableLocalWorld} from './workflow/world.js'
import {executeMigration, linkWorkflowRun} from './workflow/step-runtime.js'
import {
  persistThenResumeApproval,
  persistThenResumeElicitation,
  reconcileResolvedElicitations,
} from './workflow/approval-runtime.js'
import {createTaskToken, verifyOpaqueToken, verifyTaskToken} from './workflow/security.js'

const config = resolveWorldRuntimeConfig()
const world: World =
  config.mode === 'local' ? createDurableLocalWorld(config) : createSelectedWorld()
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

const checkpointManager = new CheckpointManager(process.env.WORKFLOW_SQLITE_PATH)
const reportDirectory =
  process.env.WORKFLOW_REPORT_DIR ??
  path.join(path.dirname(process.env.WORKFLOW_SQLITE_PATH ?? ''), 'reports')
const escalationReporter = new EscalationReporter()

function bearerToken(request: Request): string {
  const authorization = request.header('authorization')
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
}

function runIdParameter(request: Request): string {
  const runId = request.params.runId
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('A migration run ID is required.')
  }
  return runId
}

function requireApiToken(request: Request, response: Response, next: NextFunction): void {
  if (!verifyOpaqueToken(apiToken, bearerToken(request))) {
    response.status(401).json({error: 'Unauthorized'})
    return
  }
  next()
}

function requireTaskToken(request: Request, response: Response, next: NextFunction): void {
  const runId = runIdParameter(request)
  if (!verifyTaskToken(taskSecret, runId, bearerToken(request))) {
    response.status(401).json({error: 'Unauthorized workflow task'})
    return
  }
  next()
}

function migrationStatus(
  state: Awaited<ReturnType<CheckpointManager['load']>>,
  blockingElicitations: Awaited<ReturnType<CheckpointManager['listElicitations']>> = [],
) {
  if (!state) {
    return null
  }
  return {
    runId: state.runId,
    phase: state.phase,
    updatedAt: state.timestamp,
    adoOrg: state.adoOrg,
    adoProject: state.adoProject,
    githubOrg: state.githubOrg,
    apply: state.migrationConfig.apply,
    ...(state.migrationConfig.output ? {output: state.migrationConfig.output} : {}),
    concurrency: state.migrationConfig.concurrency ?? 1,
    plan: {
      githubOrg: state.githubOrg,
      teams: (state.teamPlan ?? []).map((planned) => ({
        slug: planned.team.slug,
        name: planned.team.name,
        ...(planned.parentSlug ? {parentSlug: planned.parentSlug} : {}),
        kind: planned.kind,
      })),
      memberAssignments: state.mappings.flatMap((mapping) =>
        mapping.memberMappings
          .filter((member) => member.mapped && member.githubUser)
          .map((member) => ({
            team: mapping.githubTeam.slug,
            login: member.githubUser?.login ?? '',
          })),
      ),
      repositoryGrants: (state.repositoryGrants ?? []).map((grant) => ({
        teamSlug: grant.teamSlug,
        repository: grant.repository,
        role: grant.role,
        basePermission: grant.basePermission,
        visibility: grant.visibility,
      })),
    },
    approvals: state.approvalHistory,
    blockingElicitations,
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
    output: path.join(reportDirectory, `migration-report-${runId}.md`),
  })
  const existingWorkflowRunId = await checkpointManager.getWorkflowRunId(runId)
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

app.get('/api/migrations', requireApiToken, async (request, response) => {
  const blockingOnly = request.query.blocking === 'true'
  const requestedLimit =
    typeof request.query.limit === 'string' ? Number.parseInt(request.query.limit, 10) : 100
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    response.status(400).json({error: 'limit must be a positive integer'})
    return
  }
  response.json(await checkpointManager.listWorkflowSessions(blockingOnly, requestedLimit))
})

app.get('/api/migrations/latest', requireApiToken, async (_request, response) => {
  const latest = await checkpointManager.getLatestWorkflowRun()
  if (!latest) {
    response.json(null)
    return
  }
  const blockingElicitations = await checkpointManager.listElicitations(
    latest.checkpoint.runId,
    'pending',
  )
  response.json({
    workflowRunId: latest.workflowRunId,
    workflowStatus:
      blockingElicitations.length > 0 ? 'blocked' : await getRun(latest.workflowRunId).status,
    migration: migrationStatus(latest.checkpoint, blockingElicitations),
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
  const blockingElicitations = await checkpointManager.listElicitations(runId, 'pending')
  const workflowStatus =
    blockingElicitations.length > 0 ? 'blocked' : await getRun(workflowRunId).status
  response.json({
    workflowRunId,
    workflowStatus,
    migration: migrationStatus(state, blockingElicitations),
  })
})

app.post('/api/migrations/:runId/approval', requireApiToken, async (request, response) => {
  const runId = runIdParameter(request)
  const decision = decodeApprovalDecision(request.body)
  await persistThenResumeApproval(runId, approvalToken(runId), decision)
  response.status(202).json({runId, accepted: true})
})

app.post(
  '/api/migrations/:runId/elicitations/:elicitationId',
  requireApiToken,
  async (request, response) => {
    const runId = runIdParameter(request)
    const elicitationId = request.params.elicitationId
    if (typeof elicitationId !== 'string' || elicitationId.length === 0) {
      response.status(400).json({error: 'An elicitation ID is required'})
      return
    }
    const decision = decodeElicitationDecision(request.body)
    await persistThenResumeElicitation(runId, elicitationId, decision)
    response.status(202).json({runId, elicitationId, accepted: true})
  },
)

app.get('/api/migrations/:runId/report', requireApiToken, async (request, response) => {
  const runId = runIdParameter(request)
  const state = await checkpointManager.load(runId)
  if (!state) {
    response.status(404).json({error: 'Migration not found'})
    return
  }
  const recorded = await checkpointManager.getWorkflowReport(runId)
  response.sendFile(
    path.resolve(
      recorded?.path ?? path.join(reportDirectory, `migration-report-${state.runId}.md`),
    ),
  )
})

app.post('/internal/migrations/:runId/prepare', requireTaskToken, async (request, response) => {
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
  const result = await executeMigration(input, false)
  if (result.status === 'completed' && !input.apply) {
    await checkpointManager.recordWorkflowOutcome(
      runId,
      'completed',
      result.reportPath,
      'migration',
    )
  }
  response.json(result)
})

app.post('/internal/migrations/:runId/apply', requireTaskToken, async (request, response) => {
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
  const result = await executeMigration(input, true)
  if (result.status === 'completed') {
    await checkpointManager.recordWorkflowOutcome(
      runId,
      'completed',
      result.reportPath,
      'migration',
    )
  }
  response.json(result)
})

app.post('/internal/migrations/:runId/escalation', requireTaskToken, async (request, response) => {
  const runId = runIdParameter(request)
  const input = decodeMigrationWorkflowInput(request.body)
  if (input.runId !== runId || input.workflowRunId === undefined) {
    response.status(409).json({error: 'Migration workflow identity mismatch'})
    return
  }
  const body = request.body as {elicitationId?: unknown}
  if (typeof body.elicitationId !== 'string') {
    response.status(400).json({error: 'An elicitation ID is required'})
    return
  }
  const [state, elicitation] = await Promise.all([
    checkpointManager.load(runId),
    checkpointManager.getElicitation(body.elicitationId),
  ])
  if (!state || !elicitation || elicitation.runId !== runId) {
    response.status(404).json({error: 'Escalation context was not found'})
    return
  }
  const reportPath = path.join(
    reportDirectory,
    `migration-escalation-${runId}-${elicitation.id}.md`,
  )
  await mkdir(path.dirname(reportPath), {recursive: true})
  await writeFile(
    reportPath,
    escalationReporter.render({
      checkpoint: state,
      elicitation,
      generatedAt: new Date().toISOString(),
    }),
    {encoding: 'utf8', mode: 0o600},
  )
  await checkpointManager.recordWorkflowOutcome(runId, 'escalated', reportPath, 'escalation')
  response.json({
    runId,
    reportPath,
    status: 'completed',
  })
})

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  void next
  const message = error instanceof Error ? error.message : String(error)
  response.status(500).json({error: message})
}
app.use(errorHandler)

export async function closeWorld(): Promise<void> {
  clearInterval(reconciliationTimer)
  await worldReady
  await world.close?.()
}

const reconciliationTimer = setInterval(() => {
  void reconcileResolvedElicitations().catch((error: unknown) => {
    console.error('Failed to reconcile resolved migration elicitations:', error)
  })
}, 5000)
reconciliationTimer.unref()
void worldReady
  .then(() => reconcileResolvedElicitations())
  .catch((error: unknown) => {
    console.error('Failed to reconcile migration elicitations at startup:', error)
  })

export default app
