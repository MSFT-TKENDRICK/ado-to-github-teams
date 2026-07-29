import path from 'node:path'
import {randomUUID} from 'node:crypto'
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
import type {ApprovalDecision, MigrationTaskResult, MigrationWorkflowInput} from './contracts.js'
import {toElicitationRecord, type EntraOperatorDescription} from './elicitations.js'
import {decodeApprovalDecision, decodeMigrationWorkflowInput} from './schemas.js'

function checkpointDatabase(): string | undefined {
  return process.env.WORKFLOW_SQLITE_PATH
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Bounds an apply invocation to a resumable slice. The soft deadline is kept
 * strictly below the step's HTTP timeout ({@link workerTask}, 10 minutes) so a
 * worker checkpoints and returns a continuation before the caller gives up,
 * never mutating past the caller's deadline.
 */
function applyBatchLimits(): {maxUnits: number; softDeadlineMs: number} {
  return {
    maxUnits: positiveIntEnv('WORKFLOW_APPLY_BATCH_MAX_UNITS', 250),
    softDeadlineMs: positiveIntEnv('WORKFLOW_APPLY_BATCH_DEADLINE_MS', 8 * 60_000),
  }
}

type MigrationExecutionResult = MigrationTaskResult

/**
 * How long a migration execution lease is valid without a heartbeat. A worker
 * renews at a third of this interval, so a still-live worker keeps its claim,
 * while a crashed worker's lease is reclaimable by another worker once the TTL
 * elapses. Kept well above the heartbeat cadence to avoid self-eviction.
 */
function leaseTtlMs(): number {
  return positiveIntEnv('WORKFLOW_LEASE_MS', 60_000)
}

/**
 * Upper bound on how long {@link executeMigration} waits to acquire a contended
 * lease before yielding. Doubles as backoff: on contention the caller returns a
 * continuation (apply) or a retriable error (prepare) only after this window,
 * throttling redelivery instead of hot-looping against the lease holder.
 */
function leaseAcquireTimeoutMs(): number {
  return positiveIntEnv('WORKFLOW_LEASE_ACQUIRE_TIMEOUT_MS', 5_000)
}

class MigrationLeaseUnavailableError extends Error {
  public readonly retriable = true
  public constructor(taskKey: string) {
    super(`Migration task ${taskKey} is held by another worker; retry after the lease expires.`)
    this.name = 'MigrationLeaseUnavailableError'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function resolveReportPath(input: MigrationWorkflowInput): string {
  return (
    input.output ??
    path.resolve(
      process.env.WORKFLOW_REPORT_DIR ?? process.cwd(),
      `migration-report-${input.runId}.md`,
    )
  )
}

async function acquireLeaseWithBoundedWait(
  manager: CheckpointManager,
  taskKey: string,
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const deadline = Date.now() + leaseAcquireTimeoutMs()
  for (;;) {
    const nowIso = new Date().toISOString()
    const expiresIso = new Date(Date.now() + ttlMs).toISOString()
    if (await manager.acquireMigrationLease(taskKey, owner, nowIso, expiresIso)) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await delay(500)
  }
}

function stringClaim(claims: Record<string, unknown>, ...names: string[]): string | undefined {
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
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
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
  const entraToken = await credentials.entraCredential.getToken([...credentials.entraScopes])
  const operator = entraToken
    ? describeEntraOperator(entraToken.token)
    : ({principalType: 'unknown'} as const)
  const reportPath = resolveReportPath(input)

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
        ...(apply ? {applyBatch: applyBatchLimits()} : {}),
        ...(input.prefix ? {prefix: input.prefix} : {}),
        ...(input.suffix ? {suffix: input.suffix} : {}),
        ...(input.topology ? {topology: input.topology} : {}),
      }).pipe(Effect.provide(runtimeLayer)),
    )
    if (result.pendingWork) {
      return {runId: input.runId, reportPath, status: 'in-progress'}
    }
    return {runId: input.runId, reportPath, status: 'completed'}
  } catch (error) {
    if (!(error instanceof BlockingElicitationFailure)) {
      throw error
    }
    if (!input.workflowRunId) {
      throw new Error('Blocking elicitations require a durable workflow run ID.')
    }
    const state = await checkpointManager.load(input.runId)
    if (!state || !error.request.elicitation) {
      throw new Error(`Cannot persist a blocking elicitation for migration ${input.runId}.`)
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
  const taskKey = `${input.runId}:${apply ? 'apply' : 'prepare'}`
  const owner = randomUUID()
  const ttlMs = leaseTtlMs()
  const manager = new CheckpointManager(checkpointDatabase())

  const acquired = await acquireLeaseWithBoundedWait(manager, taskKey, owner, ttlMs)
  if (!acquired) {
    // A concurrent worker holds the lease. Apply is driven by the durable
    // workflow loop, so report a continuation and let it retry after the holder
    // advances. Prepare is queue-driven, so raise a retriable error to trigger
    // redelivery. Either way we never run destructive work without the lease.
    if (apply) {
      return {
        runId: input.runId,
        reportPath: resolveReportPath(input),
        status: 'in-progress',
      }
    }
    throw new MigrationLeaseUnavailableError(taskKey)
  }

  let leaseLost = false
  const heartbeat = setInterval(
    () => {
      void manager
        .renewMigrationLease(
          taskKey,
          owner,
          new Date().toISOString(),
          new Date(Date.now() + ttlMs).toISOString(),
        )
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true
          }
        })
        .catch(() => {
          // Transient DB errors are tolerated; the TTL still bounds the lease.
        })
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  )
  heartbeat.unref?.()

  try {
    return await executeMigrationAttempt(input, apply)
  } finally {
    clearInterval(heartbeat)
    if (!leaseLost) {
      await manager.releaseMigrationLease(taskKey, owner)
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
        throw new Error(`Migration ${runId} already has an immutable approval decision.`)
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
            .map((member) => `${mapping.githubTeam.slug}:${member.githubUser?.login ?? ''}`),
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
