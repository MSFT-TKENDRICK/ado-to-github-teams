import {mkdir, writeFile} from 'node:fs/promises'
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
import {makeCopilotHealingReasonerLayer} from '../services/copilot.js'
import type {ApprovalRecord} from '../types/index.js'
import type {
  ApprovalDecision,
  ElicitationDecision,
  MigrationWorkflowInput,
} from './contracts.js'
import {
  decodeApprovalDecision,
  decodeElicitationDecision,
  decodeMigrationWorkflowInput,
} from './schemas.js'
import {
  registerApplyElicitation,
  registerHealingEscalation,
  renderEscalationReport,
  resolveElicitation,
} from './elicitations.js'

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
    makeCopilotHealingReasonerLayer(),
    makeCheckpointLayer(database),
    ReportWriterLiveLayer,
  )

  try {
    const result = await Effect.runPromise(
      runEffectMigration({
        runId: input.runId,
        adoOrg: input.adoOrg,
        adoProject: input.adoProject,
        githubOrg: input.githubOrg,
        apply,
        preserveCheckpoint: true,
        ...(input.workflowRunId ? {workflowRunId: input.workflowRunId} : {}),
        ...(input.entraActor ? {entraActor: input.entraActor} : {}),
        concurrency: Math.max(1, input.concurrency),
        output:
          input.output ??
          path.resolve(
            process.env.WORKFLOW_REPORT_DIR ?? process.cwd(),
            `migration-report-${input.runId}.md`,
          ),
        ...(input.prefix ? {prefix: input.prefix} : {}),
        ...(input.suffix ? {suffix: input.suffix} : {}),
        ...(input.topology ? {topology: input.topology} : {}),
      }).pipe(Effect.provide(runtimeLayer)),
    )
    if (!apply && input.apply) {
      await checkpointManager.update(input.runId, (state) =>
        registerApplyElicitation(state, new Date().toISOString()),
      )
    }
    return result
  } catch (error) {
    const state = await checkpointManager.load(input.runId)
    if (state) {
      const timestamp = new Date().toISOString()
      const service =
        typeof error === 'object' &&
        error !== null &&
        'service' in error &&
        typeof error.service === 'string'
          ? error.service
          : 'migration'
      const tag =
        typeof error === 'object' &&
        error !== null &&
        '_tag' in error &&
        typeof error._tag === 'string'
          ? error._tag
          : error instanceof Error
            ? error.name
            : 'UnknownFailure'
      const message = error instanceof Error ? error.message : String(error)
      const reportPath = path.join(
        path.dirname(
          input.output ??
            path.resolve(
              process.env.WORKFLOW_REPORT_DIR ?? process.cwd(),
              `migration-report-${input.runId}.md`,
            ),
        ),
        `escalation-report-${input.runId}.md`,
      )
      const registered = registerHealingEscalation(
        state,
        {tag, service, message},
        timestamp,
        reportPath,
      )
      await checkpointManager.save(registered.state)
      await mkdir(path.dirname(reportPath), {recursive: true})
      await writeFile(
        reportPath,
        renderEscalationReport(registered.state, registered.elicitation),
        'utf8',
      )
    }
    throw error
  }
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
    if (
      (checkpoint.elicitations ?? []).some(
        (elicitation) =>
          elicitation.kind === 'apply-approval' &&
          elicitation.status === 'pending',
      )
    ) {
      throw new Error(
        `Migration ${runId} requires a fingerprint-bound elicitation decision.`,
      )
    }
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
        teams: (checkpoint.teamPlan ?? []).map((planned) => planned.team.slug),
        teamPlan: (checkpoint.teamPlan ?? []).map((planned) => ({
          slug: planned.team.slug,
          name: planned.team.name,
          parentSlug: planned.parentSlug ?? null,
          kind: planned.kind,
        })),
        memberAssignments: checkpoint.mappings.flatMap((mapping) =>
          mapping.memberMappings
            .filter((member) => member.mapped && member.githubUser)
            .map(
              (member) =>
                `${mapping.githubTeam.slug}:${member.githubUser?.login ?? ''}`,
            ),
        ),
        repositoryGrants: (checkpoint.repositoryGrants ?? []).map((grant) => ({
          teamSlug: grant.teamSlug,
          repository: grant.repository,
          role: grant.role,
          basePermission: grant.basePermission,
          visibility: grant.visibility,
        })),
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

export async function persistElicitationDecision(
  runId: string,
  rawDecision: ElicitationDecision,
): Promise<ApprovalDecision | null> {
  const decision = decodeElicitationDecision(rawDecision)
  const manager = new CheckpointManager(checkpointDatabase())
  let approval: ApprovalDecision | null = null
  const updated = await manager.update(runId, (checkpoint) => {
    const elicitation = (checkpoint.elicitations ?? []).find(
      (candidate) => candidate.id === decision.elicitationId,
    )
    const wasAnswered = elicitation?.answer !== undefined
    const resolved = resolveElicitation(
      checkpoint,
      decision,
      new Date().toISOString(),
    )
    if (elicitation?.kind !== 'apply-approval') {
      return resolved
    }
    if (wasAnswered) {
      if (!elicitation.answer?.resumeDeliveredAt) {
        approval = {
          approved: elicitation.answer?.action === 'approve',
          approvedBy: elicitation.answer?.answeredBy ?? decision.answeredBy,
          ...(elicitation.answer?.comment === undefined
            ? {}
            : {comment: elicitation.answer.comment}),
        }
      }
      return resolved
    }
    if (!['approve', 'reject'].includes(decision.action)) {
      throw new Error(
        `Apply elicitation ${decision.elicitationId} requires approve or reject.`,
      )
    }
    approval = {
      approved: decision.action === 'approve',
      approvedBy: decision.answeredBy,
      ...(decision.comment === undefined ? {} : {comment: decision.comment}),
    }
    const existing = resolved.approvalHistory.find(
      (record) => record.action === 'Apply migration',
    )
    if (existing) {
      if (existing.approved !== approval.approved) {
        throw new Error(
          `Migration ${runId} already has an immutable approval decision.`,
        )
      }
      return resolved
    }
    return {
      ...resolved,
      approvalHistory: [
        ...resolved.approvalHistory,
        {
          action: 'Apply migration',
          context: JSON.stringify({
            elicitationId: decision.elicitationId,
            contextFingerprint: decision.expectedFingerprint,
            approvedBy: decision.answeredBy,
            ...(decision.comment === undefined
              ? {}
              : {comment: decision.comment}),
          }),
          approved: approval.approved,
          timestamp: resolved.timestamp,
        },
      ],
    }
  })
  if (!updated) {
    throw new Error(`Cannot answer elicitation for missing migration ${runId}.`)
  }
  return approval
}

export async function markElicitationResumeDelivered(
  runId: string,
  elicitationId: string,
  answerId: string,
): Promise<void> {
  const manager = new CheckpointManager(checkpointDatabase())
  const updated = await manager.update(runId, (checkpoint) => {
    const timestamp = new Date().toISOString()
    const elicitations = checkpoint.elicitations ?? []
    const index = elicitations.findIndex(
      (elicitation) => elicitation.id === elicitationId,
    )
    const elicitation = elicitations[index]
    if (!elicitation?.answer || elicitation.answer.answerId !== answerId) {
      throw new Error(
        `Cannot confirm resume delivery for elicitation ${elicitationId}.`,
      )
    }
    if (elicitation.answer.resumeDeliveredAt) {
      return checkpoint
    }
    const next = [...elicitations]
    next[index] = {
      ...elicitation,
      answer: {
        ...elicitation.answer,
        resumeDeliveredAt: timestamp,
      },
    }
    return {
      ...checkpoint,
      timestamp,
      elicitations: next,
    }
  })
  if (!updated) {
    throw new Error(`Cannot confirm resume delivery for missing migration ${runId}.`)
  }
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
