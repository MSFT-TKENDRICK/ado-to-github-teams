import path from 'node:path'
import {Effect, Layer} from 'effect'
import {AuthServiceTag} from '../effect/services.js'
import {
  AuthLiveLayer,
  makeAdoLayer,
  makeCheckpointLayer,
  makeEntraLayer,
  makeGitHubLayer,
  makeWorkflowApprovalLayer,
  ReportWriterLiveLayer,
  validateCredentialsEffect,
} from '../effect/layers.js'
import {runEffectMigration} from '../effect/migration.js'
import {CheckpointManager} from '../checkpoints/manager.js'
import type {ApprovalRecord} from '../types/index.js'
import type {
  ApprovalDecision,
  MigrationWorkflowInput,
} from './contracts.js'
import {
  decodeApprovalDecision,
  decodeMigrationWorkflowInput,
} from './schemas.js'

function checkpointDatabase(): string | undefined {
  return process.env.WORKFLOW_SQLITE_PATH
}

type MigrationExecutionResult = {reportPath: string; runId: string}

const activeMigrations = new Map<string, Promise<MigrationExecutionResult>>()

async function executeMigrationAttempt(
  input: MigrationWorkflowInput,
  apply: boolean,
): Promise<MigrationExecutionResult> {
  const database = checkpointDatabase()
  const checkpointManager = new CheckpointManager(database)
  const checkpoint = await checkpointManager.load(input.runId)
  const approvalHistory = checkpoint?.approvalHistory ?? []

  const credentials = await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthServiceTag
      return yield* auth.resolveCredentials
    }).pipe(Effect.provide(AuthLiveLayer)),
  )
  await Effect.runPromise(validateCredentialsEffect(credentials, input.adoOrg))

  const runtimeLayer = Layer.mergeAll(
    makeAdoLayer(credentials, input.adoOrg),
    makeGitHubLayer(credentials, input.githubOrg),
    makeEntraLayer(credentials),
    makeWorkflowApprovalLayer(apply, approvalHistory),
    makeCheckpointLayer(database),
    ReportWriterLiveLayer,
  )

  return Effect.runPromise(
    runEffectMigration({
      runId: input.runId,
      adoOrg: input.adoOrg,
      adoProject: input.adoProject,
      githubOrg: input.githubOrg,
      apply,
      preserveCheckpoint: true,
      concurrency: Math.max(1, input.concurrency),
      output:
        input.output ??
        path.resolve(
          process.env.WORKFLOW_REPORT_DIR ?? process.cwd(),
          `migration-report-${input.runId}.md`,
        ),
      ...(input.prefix ? {prefix: input.prefix} : {}),
      ...(input.suffix ? {suffix: input.suffix} : {}),
    }).pipe(Effect.provide(runtimeLayer)),
  )
}

export async function executeMigration(
  rawInput: MigrationWorkflowInput,
  apply: boolean,
): Promise<MigrationExecutionResult> {
  const input = decodeMigrationWorkflowInput(rawInput)
  const executionKey = `${input.runId}:${apply ? 'apply' : 'prepare'}`
  const active = activeMigrations.get(executionKey)
  if (active) {
    return active
  }

  const execution = executeMigrationAttempt(input, apply)
  activeMigrations.set(executionKey, execution)
  try {
    return await execution
  } finally {
    if (activeMigrations.get(executionKey) === execution) {
      activeMigrations.delete(executionKey)
    }
  }
}

export async function persistApproval(
  runId: string,
  rawDecision: ApprovalDecision,
): Promise<ApprovalDecision> {
  const decision = decodeApprovalDecision(rawDecision)
  const manager = new CheckpointManager(checkpointDatabase())
  const state = await manager.update(runId, (checkpoint) => {
    const existingApproval = checkpoint.approvalHistory.find(
      (record) => record.action === 'Apply migration',
    )
    if (existingApproval) {
      const context = JSON.parse(existingApproval.context) as unknown
      const matchesExisting =
        typeof context === 'object' &&
        context !== null &&
        'approvedBy' in context &&
        context.approvedBy === decision.approvedBy &&
        ('comment' in context ? context.comment : undefined) === decision.comment
      if (existingApproval.approved !== decision.approved || !matchesExisting) {
        throw new Error(
          `Migration ${runId} already has an immutable approval decision.`,
        )
      }
      return checkpoint
    }

    const record: ApprovalRecord = {
      action: 'Apply migration',
      context: JSON.stringify({
        runId,
        githubOrg: checkpoint.githubOrg,
        teams: checkpoint.mappings.map((mapping) => mapping.githubTeam.slug),
        memberAssignments: checkpoint.mappings.flatMap((mapping) =>
          mapping.memberMappings
            .filter((member) => member.mapped && member.githubUser)
            .map(
              (member) =>
                `${mapping.githubTeam.slug}:${member.githubUser?.login ?? ''}`,
            ),
        ),
        approvedBy: decision.approvedBy,
        ...(decision.comment === undefined ? {} : {comment: decision.comment}),
      }),
      approved: decision.approved,
      timestamp: new Date().toISOString(),
    }
    checkpoint.approvalHistory = [...checkpoint.approvalHistory, record]
    checkpoint.timestamp = record.timestamp
    return checkpoint
  })
  if (!state) {
    throw new Error(`Cannot record approval for missing migration ${runId}.`)
  }
  return decision
}

export async function linkWorkflowRun(
  migrationRunId: string,
  workflowRunId: string,
): Promise<void> {
  await new CheckpointManager(checkpointDatabase()).linkWorkflow({
    migrationRunId,
    workflowRunId,
    createdAt: new Date().toISOString(),
  })
}
