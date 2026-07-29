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
import {BlockingElicitationFailure} from '../effect/errors.js'
import {CheckpointManager} from '../checkpoints/manager.js'
import {makeCopilotHealingReasonerLayer} from '../services/copilot.js'
import type {ApprovalRecord} from '../types/index.js'
import type {
  ApprovalDecision,
  MigrationTaskResult,
  MigrationWorkflowInput,
} from './contracts.js'
import {
  toElicitationRecord,
  type EntraOperatorDescription,
} from './elicitations.js'
import {
  decodeApprovalDecision,
  decodeMigrationWorkflowInput,
} from './schemas.js'

function checkpointDatabase(): string | undefined {
  return process.env.WORKFLOW_SQLITE_PATH
}

type MigrationExecutionResult = MigrationTaskResult

const activeMigrations = new Map<string, Promise<MigrationExecutionResult>>()

function stringClaim(
  claims: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  const value = names.map((name) => claims[name]).find((claim) => typeof claim === 'string')
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function describeEntraOperator(token: string): EntraOperatorDescription {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) {
    return {principalType: 'unknown'}
  }
  let claims: Record<string, unknown>
  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {principalType: 'unknown'}
    }
    claims = parsed as Record<string, unknown>
  } catch {
    return {principalType: 'unknown'}
  }
  const identityType = stringClaim(claims, 'idtyp')
  const principalType =
    typeof claims.xms_mirid === 'string'
      ? 'managed-identity'
      : identityType === 'app' || stringClaim(claims, 'appid', 'azp')
        ? 'service-principal'
        : stringClaim(claims, 'upn', 'preferred_username')
          ? 'user'
          : 'unknown'
  const displayName = stringClaim(claims, 'name')
  const userPrincipalName = stringClaim(claims, 'upn', 'preferred_username')
  const tenantId = stringClaim(claims, 'tid')
  const objectId = stringClaim(claims, 'oid', 'sub')
  const clientId = stringClaim(claims, 'appid', 'azp')
  return {
    principalType,
    ...(displayName ? {displayName} : {}),
    ...(userPrincipalName ? {userPrincipalName} : {}),
    ...(tenantId ? {tenantId} : {}),
    ...(objectId ? {objectId} : {}),
    ...(clientId ? {clientId} : {}),
  }
}

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
  const entraToken = await credentials.entraCredential.getToken([
    ...credentials.entraScopes,
  ])
  const operator = entraToken
    ? describeEntraOperator(entraToken.token)
    : ({principalType: 'unknown'} as const)
  const reportPath =
    input.output ??
    path.resolve(
      process.env.WORKFLOW_REPORT_DIR ?? process.cwd(),
      `migration-report-${input.runId}.md`,
    )

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
      concurrency: Math.max(1, input.concurrency),
      output: reportPath,
      ...(input.prefix ? {prefix: input.prefix} : {}),
      ...(input.suffix ? {suffix: input.suffix} : {}),
      }).pipe(Effect.provide(runtimeLayer)),
    )
    return {...result, status: 'completed'}
  } catch (error) {
    if (!(error instanceof BlockingElicitationFailure)) {
      throw error
    }
    if (!input.workflowRunId) {
      throw new Error('Blocking elicitations require a durable workflow run ID.')
    }
    const state = await checkpointManager.load(input.runId)
    if (!state || !error.request.elicitation) {
      throw new Error(
        `Cannot persist a blocking elicitation for migration ${input.runId}.`,
      )
    }
    const metadata = error.request.elicitation
    const occurrence = state.failureLog.filter(
      (entry) =>
        entry.target === metadata.target &&
        (entry.failureTag ?? entry.failureMode) === metadata.failureMode,
    ).length
    const elicitation = await checkpointManager.createElicitation(
      toElicitationRecord({
        runId: input.runId,
        workflowRunId: input.workflowRunId,
        phase: state.phase,
        occurrence,
        request: error.request,
        operator,
        source: {adoOrg: input.adoOrg, adoProject: input.adoProject},
        targetConfiguration: {
          githubOrg: input.githubOrg,
          apply,
          concurrency: Math.max(1, input.concurrency),
          prefix: input.prefix ?? '',
          suffix: input.suffix ?? '',
        },
        createdAt: new Date().toISOString(),
      }),
    )
    return {
      runId: input.runId,
      reportPath,
      status: 'needs-elicitation',
      elicitation,
    }
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
