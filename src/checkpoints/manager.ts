import {mkdir, readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {homedir} from 'node:os'
import path from 'node:path'
import type {DatabaseSync} from 'node:sqlite'
import {Effect} from 'effect'
import {decodeCheckpoint} from '../effect/schemas.js'
import type {CheckpointState} from '../types/index.js'
import type {
  ElicitationDecision,
  ElicitationRecord,
  MigrationSessionSummary,
} from '../workflow/elicitations.js'

export interface CheckpointListItem {
  runId: string
  timestamp: string
  phase: string
}

export interface WorkflowRunLink {
  migrationRunId: string
  workflowRunId: string
  createdAt: string
}

export interface LatestWorkflowRun {
  checkpoint: CheckpointState
  workflowRunId: string
}

interface ElicitationRow {
  payload: string
}

interface SessionRow {
  runId: string
  workflowRunId: string
  workflowStatus: string
  phase: string
  updatedAt: string
  adoOrg: string
  adoProject: string
  githubOrg: string
  reportKind: 'migration' | 'escalation' | null
}

const DATABASE_FILENAME = 'workflow.db'

function resolveDatabasePath(location: string): string {
  return path.extname(location).toLowerCase() === '.db'
    ? location
    : path.join(location, DATABASE_FILENAME)
}

export class CheckpointManager {
  private readonly databasePath: string
  private readonly legacyCheckpointDirectory: string | null

  public constructor(
    location = path.join(homedir(), '.ado-github-teams', DATABASE_FILENAME),
  ) {
    this.databasePath = resolveDatabasePath(location)
    this.legacyCheckpointDirectory =
      path.extname(location).toLowerCase() === '.db' ? null : location
  }

  public async save(state: CheckpointState): Promise<void> {
    const validated = await Effect.runPromise(decodeCheckpoint(state))
    await this.withDatabase((database) => {
      database.exec('BEGIN IMMEDIATE')
      try {
        database
          .prepare(
            `INSERT INTO migration_checkpoints (
              run_id,
              schema_version,
              configuration_hash,
              phase,
              updated_at,
              payload
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
              schema_version = excluded.schema_version,
              configuration_hash = excluded.configuration_hash,
              phase = excluded.phase,
              updated_at = excluded.updated_at,
              payload = excluded.payload`,
          )
          .run(
            validated.runId,
            validated.schemaVersion,
            validated.configurationHash,
            validated.phase,
            validated.timestamp,
            JSON.stringify(validated),
          )
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  public async load(runId: string): Promise<CheckpointState | null> {
    const checkpoint = await this.withDatabase(async (database) => {
      const row = database
        .prepare('SELECT payload FROM migration_checkpoints WHERE run_id = ?')
        .get(runId) as {payload: string} | undefined
      if (!row) {
        return null
      }

      const raw = JSON.parse(row.payload) as unknown
      return Effect.runPromise(decodeCheckpoint(raw))
    })
    if (checkpoint) {
      return checkpoint
    }
    await this.rejectLegacyCheckpoint(runId)
    return null
  }

  public async loadLatest(): Promise<CheckpointState | null> {
    return this.withDatabase(async (database) => {
      const row = database
        .prepare(
          `SELECT payload
           FROM migration_checkpoints
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get() as {payload: string} | undefined
      if (!row) {
        return null
      }
      return Effect.runPromise(
        decodeCheckpoint(JSON.parse(row.payload) as unknown),
      )
    })
  }

  public async update(
    runId: string,
    transform: (state: CheckpointState) => CheckpointState,
  ): Promise<CheckpointState | null> {
    return this.withDatabase((database) => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database
          .prepare('SELECT payload FROM migration_checkpoints WHERE run_id = ?')
          .get(runId) as {payload: string} | undefined
        if (!row) {
          database.exec('COMMIT')
          return null
        }

        const current = Effect.runSync(
          decodeCheckpoint(JSON.parse(row.payload) as unknown),
        )
        const validated = Effect.runSync(decodeCheckpoint(transform(current)))
        if (validated.runId !== runId) {
          throw new Error('Checkpoint updates cannot change the migration run ID.')
        }
        database
          .prepare(
            `UPDATE migration_checkpoints
             SET schema_version = ?,
                 configuration_hash = ?,
                 phase = ?,
                 updated_at = ?,
                 payload = ?
             WHERE run_id = ?`,
          )
          .run(
            validated.schemaVersion,
            validated.configurationHash,
            validated.phase,
            validated.timestamp,
            JSON.stringify(validated),
            validated.runId,
          )
        database.exec('COMMIT')
        return validated
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  public async listCheckpoints(): Promise<CheckpointListItem[]> {
    return this.withDatabase((database) =>
      (
        database
          .prepare(
            `SELECT
              run_id AS runId,
              updated_at AS timestamp,
              phase
            FROM migration_checkpoints
            ORDER BY updated_at DESC`,
          )
          .all() as unknown as CheckpointListItem[]
      ).map((item) => ({...item})),
    )
  }

  public async delete(runId: string): Promise<void> {
    await this.withDatabase((database) => {
      database.prepare('DELETE FROM migration_checkpoints WHERE run_id = ?').run(runId)
    })
  }

  public async createElicitation(
    elicitation: ElicitationRecord,
  ): Promise<ElicitationRecord> {
    return this.withDatabase((database) => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const existingPending = (
          database
            .prepare(
              `SELECT payload
               FROM migration_elicitations
               WHERE run_id = ? AND status = 'pending'`,
            )
            .all(elicitation.runId) as unknown as ElicitationRow[]
        )
          .map((row) => JSON.parse(row.payload) as ElicitationRecord)
          .find(
            (candidate) =>
              candidate.phase === elicitation.phase &&
              candidate.operation === elicitation.operation &&
              candidate.target === elicitation.target &&
              candidate.failureMode === elicitation.failureMode,
          )
        if (existingPending) {
          database
            .prepare(
              `UPDATE migration_workflow_runs
               SET workflow_status = 'blocked'
               WHERE migration_run_id = ?`,
            )
            .run(elicitation.runId)
          database.exec('COMMIT')
          return existingPending
        }
        database
          .prepare(
            `INSERT INTO migration_elicitations (
              elicitation_id,
              run_id,
              workflow_run_id,
              hook_token,
              status,
              updated_at,
              payload
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
            ON CONFLICT(elicitation_id) DO NOTHING`,
          )
          .run(
            elicitation.id,
            elicitation.runId,
            elicitation.workflowRunId,
            elicitation.hookToken,
            elicitation.updatedAt,
            JSON.stringify(elicitation),
          )
        const row = database
          .prepare(
            'SELECT payload FROM migration_elicitations WHERE elicitation_id = ?',
          )
          .get(elicitation.id) as ElicitationRow | undefined
        if (!row) {
          throw new Error(`Failed to persist elicitation ${elicitation.id}.`)
        }
        const persisted = JSON.parse(row.payload) as ElicitationRecord
        if (
          persisted.runId !== elicitation.runId ||
          persisted.workflowRunId !== elicitation.workflowRunId ||
          persisted.hookToken !== elicitation.hookToken
        ) {
          throw new Error(`Elicitation ${elicitation.id} has conflicting identity metadata.`)
        }
        if (persisted.status !== 'pending') {
          throw new Error(
            `Elicitation ${elicitation.id} collides with an already resolved occurrence.`,
          )
        }
        database
          .prepare(
            `UPDATE migration_workflow_runs
             SET workflow_status = 'blocked'
             WHERE migration_run_id = ?`,
          )
          .run(elicitation.runId)
        database.exec('COMMIT')
        return persisted
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  public async getElicitation(
    elicitationId: string,
  ): Promise<ElicitationRecord | null> {
    return this.withDatabase((database) => {
      const row = database
        .prepare(
          'SELECT payload FROM migration_elicitations WHERE elicitation_id = ?',
        )
        .get(elicitationId) as ElicitationRow | undefined
      return row ? (JSON.parse(row.payload) as ElicitationRecord) : null
    })
  }

  public async listElicitations(
    runId?: string,
    status?: ElicitationRecord['status'],
  ): Promise<ElicitationRecord[]> {
    return this.withDatabase((database) => {
      const conditions: string[] = []
      const parameters: string[] = []
      if (runId) {
        conditions.push('run_id = ?')
        parameters.push(runId)
      }
      if (status) {
        conditions.push('status = ?')
        parameters.push(status)
      }
      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const rows = database
        .prepare(
          `SELECT payload
           FROM migration_elicitations
           ${where}
           ORDER BY updated_at DESC`,
        )
        .all(...parameters) as unknown as ElicitationRow[]
      return rows.map((row) => JSON.parse(row.payload) as ElicitationRecord)
    })
  }

  public async resolveElicitation(
    elicitationId: string,
    decision: ElicitationDecision,
    decidedAt = new Date().toISOString(),
  ): Promise<ElicitationRecord> {
    return this.withDatabase((database) => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database
          .prepare(
            'SELECT payload FROM migration_elicitations WHERE elicitation_id = ?',
          )
          .get(elicitationId) as ElicitationRow | undefined
        if (!row) {
          throw new Error(`Elicitation ${elicitationId} was not found.`)
        }
        const current = JSON.parse(row.payload) as ElicitationRecord
        if (!current.choices.includes(decision.action)) {
          throw new Error(
            `Elicitation ${elicitationId} does not allow ${decision.action}.`,
          )
        }
        if (current.decision) {
          if (JSON.stringify(current.decision) !== JSON.stringify(decision)) {
            throw new Error(
              `Elicitation ${elicitationId} already has an immutable decision.`,
            )
          }
          database.exec('COMMIT')
          return current
        }
        const resolved: ElicitationRecord = {
          ...current,
          status: 'resolved',
          decision,
          updatedAt: decidedAt,
        }
        database
          .prepare(
            `UPDATE migration_elicitations
             SET status = 'resolved', updated_at = ?, payload = ?
             WHERE elicitation_id = ?`,
          )
          .run(decidedAt, JSON.stringify(resolved), elicitationId)

        const checkpointRow = database
          .prepare('SELECT payload FROM migration_checkpoints WHERE run_id = ?')
          .get(current.runId) as {payload: string} | undefined
        if (!checkpointRow) {
          throw new Error(
            `Cannot resolve elicitation for missing migration ${current.runId}.`,
          )
        }
        const checkpoint = Effect.runSync(
          decodeCheckpoint(JSON.parse(checkpointRow.payload) as unknown),
        )
        const failureLog = checkpoint.failureLog.map((entry) =>
          !entry.resolved &&
          entry.target === current.target &&
          (entry.failureTag ?? entry.failureMode) === current.failureMode
            ? {
                ...entry,
                userApproved: decision.action !== 'abort',
                resolved: decision.action !== 'retry',
              }
            : entry,
        )
        const skippedItems =
          decision.action === 'skip' &&
          !checkpoint.skippedItems.some(
            (item) =>
              item.type === current.targetType && item.name === current.target,
          )
            ? [
                ...checkpoint.skippedItems,
                {
                  type: current.targetType,
                  name: current.target,
                  reason: current.summary,
                },
              ]
            : checkpoint.skippedItems
        const updatedCheckpoint: CheckpointState = {
          ...checkpoint,
          timestamp: decidedAt,
          failureLog,
          skippedItems,
        }
        database
          .prepare(
            `UPDATE migration_checkpoints
             SET updated_at = ?, payload = ?
             WHERE run_id = ?`,
          )
          .run(decidedAt, JSON.stringify(updatedCheckpoint), current.runId)
        database.exec('COMMIT')
        return resolved
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  public async markElicitationResumed(
    elicitationId: string,
    resumeOwner?: string,
    resumedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.withDatabase((database) => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database
          .prepare(
            'SELECT payload FROM migration_elicitations WHERE elicitation_id = ?',
          )
          .get(elicitationId) as ElicitationRow | undefined
        if (!row) {
          throw new Error(`Elicitation ${elicitationId} was not found.`)
        }
        const current = JSON.parse(row.payload) as ElicitationRecord
        if (!current.decision) {
          throw new Error(`Elicitation ${elicitationId} has not been resolved.`)
        }
        const resumed: ElicitationRecord = {
          ...current,
          resumedAt: current.resumedAt ?? resumedAt,
        }
        database
          .prepare(
            `UPDATE migration_elicitations
             SET payload = ?, resume_owner = NULL, resume_claimed_at = NULL
             WHERE elicitation_id = ?
               AND (? IS NULL OR resume_owner = ?)`,
          )
          .run(
            JSON.stringify(resumed),
            elicitationId,
            resumeOwner ?? null,
            resumeOwner ?? null,
          )
        database
          .prepare(
            `UPDATE migration_workflow_runs
             SET workflow_status = 'running'
             WHERE migration_run_id = ?
               AND workflow_status = 'blocked'`,
          )
          .run(current.runId)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  public async claimElicitationResume(
    elicitationId: string,
    resumeOwner: string,
    claimedAt: string,
    staleBefore: string,
  ): Promise<boolean> {
    return this.withDatabase((database) => {
      const result = database
        .prepare(
          `UPDATE migration_elicitations
           SET resume_owner = ?, resume_claimed_at = ?
           WHERE elicitation_id = ?
             AND status = 'resolved'
             AND json_extract(payload, '$.resumedAt') IS NULL
             AND (
               resume_owner IS NULL OR
               resume_claimed_at IS NULL OR
               resume_claimed_at < ?
             )`,
        )
        .run(resumeOwner, claimedAt, elicitationId, staleBefore)
      return result.changes === 1
    })
  }

  public async releaseElicitationResume(
    elicitationId: string,
    resumeOwner: string,
  ): Promise<void> {
    await this.withDatabase((database) => {
      database
        .prepare(
          `UPDATE migration_elicitations
           SET resume_owner = NULL, resume_claimed_at = NULL
           WHERE elicitation_id = ? AND resume_owner = ?`,
        )
        .run(elicitationId, resumeOwner)
    })
  }

  /**
   * Attempts to acquire (or re-acquire) a durable execution lease for a task.
   * The lease protects at-least-once redelivery and multiple workers from
   * concurrently mutating the same migration: only the lease holder runs the
   * destructive work, and a single-writer transition keeps checkpoint updates
   * safe from lost updates.
   *
   * Acquisition succeeds when there is no lease, when the lease is already held
   * by {@link owner} (re-entrant renewal after redelivery to the same worker),
   * or when the existing lease has expired (crash recovery — a worker that
   * stopped heart-beating loses its claim once `lease_expires_at` passes).
   *
   * @returns true if this owner now holds the lease.
   */
  public async acquireMigrationLease(
    taskKey: string,
    owner: string,
    nowIso: string,
    leaseExpiresAtIso: string,
  ): Promise<boolean> {
    return this.withDatabase((database) => {
      database.exec('BEGIN IMMEDIATE')
      try {
        const existing = database
          .prepare(
            `SELECT owner, lease_expires_at AS leaseExpiresAt
             FROM migration_task_leases
             WHERE task_key = ?`,
          )
          .get(taskKey) as
          | {owner: string; leaseExpiresAt: string}
          | undefined
        const isReclaimable =
          !existing ||
          existing.owner === owner ||
          existing.leaseExpiresAt <= nowIso
        if (!isReclaimable) {
          database.exec('ROLLBACK')
          return false
        }
        database
          .prepare(
            `INSERT INTO migration_task_leases (
               task_key, owner, claimed_at, heartbeat_at, lease_expires_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(task_key) DO UPDATE SET
               owner = excluded.owner,
               claimed_at = excluded.claimed_at,
               heartbeat_at = excluded.heartbeat_at,
               lease_expires_at = excluded.lease_expires_at`,
          )
          .run(taskKey, owner, nowIso, nowIso, leaseExpiresAtIso)
        database.exec('COMMIT')
        return true
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  /**
   * Extends a held lease. Only the current owner can renew; a renewal for a
   * lease that has been reclaimed by another worker returns false so the caller
   * can abort rather than keep mutating after losing its claim.
   */
  public async renewMigrationLease(
    taskKey: string,
    owner: string,
    nowIso: string,
    leaseExpiresAtIso: string,
  ): Promise<boolean> {
    return this.withDatabase((database) => {
      const result = database
        .prepare(
          `UPDATE migration_task_leases
           SET heartbeat_at = ?, lease_expires_at = ?
           WHERE task_key = ? AND owner = ?`,
        )
        .run(nowIso, leaseExpiresAtIso, taskKey, owner)
      return result.changes === 1
    })
  }

  /** Releases a held lease. A no-op when another worker already reclaimed it. */
  public async releaseMigrationLease(
    taskKey: string,
    owner: string,
  ): Promise<void> {
    await this.withDatabase((database) => {
      database
        .prepare(
          `DELETE FROM migration_task_leases
           WHERE task_key = ? AND owner = ?`,
        )
        .run(taskKey, owner)
    })
  }

  public async listPendingResumptions(): Promise<ElicitationRecord[]> {
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT payload
           FROM migration_elicitations
           WHERE status = 'resolved'
             AND json_extract(payload, '$.resumedAt') IS NULL
           ORDER BY updated_at ASC`,
        )
        .all() as unknown as ElicitationRow[]
      return rows.map((row) => JSON.parse(row.payload) as ElicitationRecord)
    })
  }

  public async listWorkflowSessions(
    blockingOnly = false,
    limit = 100,
  ): Promise<MigrationSessionSummary[]> {
    return this.withDatabase((database) => {
      const boundedLimit = Math.min(Math.max(limit, 1), 500)
      const rows = database
        .prepare(
          `SELECT
             checkpoint.run_id AS runId,
             workflow.workflow_run_id AS workflowRunId,
             workflow.workflow_status AS workflowStatus,
             checkpoint.phase,
             checkpoint.updated_at AS updatedAt,
             json_extract(checkpoint.payload, '$.adoOrg') AS adoOrg,
             json_extract(checkpoint.payload, '$.adoProject') AS adoProject,
             json_extract(checkpoint.payload, '$.githubOrg') AS githubOrg,
             workflow.report_kind AS reportKind
           FROM migration_checkpoints AS checkpoint
           INNER JOIN migration_workflow_runs AS workflow
             ON workflow.migration_run_id = checkpoint.run_id
           WHERE (? = 0 OR EXISTS (
             SELECT 1
             FROM migration_elicitations AS elicitation
             WHERE elicitation.run_id = checkpoint.run_id
               AND elicitation.status = 'pending'
           ))
           ORDER BY
             EXISTS (
               SELECT 1
               FROM migration_elicitations AS elicitation
               WHERE elicitation.run_id = checkpoint.run_id
                 AND elicitation.status = 'pending'
             ) DESC,
             checkpoint.updated_at DESC
           LIMIT ?`,
        )
        .all(blockingOnly ? 1 : 0, boundedLimit) as unknown as SessionRow[]
      const runIds = rows.map((row) => row.runId)
      const pendingByRun = new Map<string, ElicitationRecord[]>()
      if (runIds.length > 0) {
        const placeholders = runIds.map(() => '?').join(', ')
        const elicitations = database
          .prepare(
            `SELECT payload
             FROM migration_elicitations
             WHERE status = 'pending'
               AND run_id IN (${placeholders})
             ORDER BY updated_at ASC`,
          )
          .all(...runIds) as unknown as ElicitationRow[]
        for (const item of elicitations) {
          const elicitation = JSON.parse(item.payload) as ElicitationRecord
          const current = pendingByRun.get(elicitation.runId) ?? []
          current.push(elicitation)
          pendingByRun.set(elicitation.runId, current)
        }
      }
      return rows.map((row) => ({
        runId: row.runId,
        workflowRunId: row.workflowRunId,
        workflowStatus:
          (pendingByRun.get(row.runId)?.length ?? 0) > 0
            ? 'blocked'
            : row.workflowStatus,
        phase: row.phase,
        updatedAt: row.updatedAt,
        adoOrg: row.adoOrg,
        adoProject: row.adoProject,
        githubOrg: row.githubOrg,
        blockingElicitations: pendingByRun.get(row.runId) ?? [],
        ...(row.reportKind ? {reportKind: row.reportKind} : {}),
      }))
    })
  }

  public async recordWorkflowOutcome(
    runId: string,
    status: string,
    reportPath?: string,
    reportKind?: 'migration' | 'escalation',
  ): Promise<void> {
    await this.withDatabase((database) => {
      database
        .prepare(
          `UPDATE migration_workflow_runs
           SET workflow_status = ?,
               report_path = COALESCE(?, report_path),
               report_kind = COALESCE(?, report_kind)
           WHERE migration_run_id = ?`,
        )
        .run(status, reportPath ?? null, reportKind ?? null, runId)
    })
  }

  public async getWorkflowReport(
    runId: string,
  ): Promise<{path: string; kind: 'migration' | 'escalation'} | null> {
    return this.withDatabase((database) => {
      const row = database
        .prepare(
          `SELECT report_path AS path, report_kind AS kind
           FROM migration_workflow_runs
           WHERE migration_run_id = ?
             AND report_path IS NOT NULL
             AND report_kind IS NOT NULL`,
        )
        .get(runId) as
        | {path: string; kind: 'migration' | 'escalation'}
        | undefined
      return row ?? null
    })
  }

  public async linkWorkflow(link: WorkflowRunLink): Promise<void> {
    await this.withDatabase((database) => {
      database.exec('BEGIN IMMEDIATE')
      try {
        database
          .prepare(
            `INSERT INTO migration_workflow_runs (
              migration_run_id,
              workflow_run_id,
              created_at
            ) VALUES (?, ?, ?)
            ON CONFLICT(migration_run_id) DO NOTHING`,
          )
          .run(link.migrationRunId, link.workflowRunId, link.createdAt)
        const existing = database
          .prepare(
            `SELECT workflow_run_id AS workflowRunId
             FROM migration_workflow_runs
             WHERE migration_run_id = ?`,
          )
          .get(link.migrationRunId) as {workflowRunId: string} | undefined
        if (existing?.workflowRunId !== link.workflowRunId) {
          throw new Error(
            `Migration ${link.migrationRunId} is already linked to workflow ${existing?.workflowRunId ?? 'unknown'}.`,
          )
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  public async getWorkflowRunId(
    migrationRunId: string,
  ): Promise<string | null> {
    return this.withDatabase((database) => {
      const row = database
        .prepare(
          `SELECT workflow_run_id AS workflowRunId
           FROM migration_workflow_runs
           WHERE migration_run_id = ?`,
        )
        .get(migrationRunId) as {workflowRunId: string} | undefined
      return row?.workflowRunId ?? null
    })
  }

  public async getLatestWorkflowRun(): Promise<LatestWorkflowRun | null> {
    return this.withDatabase(async (database) => {
      const row = database
        .prepare(
          `SELECT
             checkpoint.payload,
             workflow.workflow_run_id AS workflowRunId
           FROM migration_checkpoints AS checkpoint
           INNER JOIN migration_workflow_runs AS workflow
             ON workflow.migration_run_id = checkpoint.run_id
           ORDER BY checkpoint.updated_at DESC
           LIMIT 1`,
        )
        .get() as {payload: string; workflowRunId: string} | undefined
      if (!row) {
        return null
      }
      return {
        checkpoint: await Effect.runPromise(
          decodeCheckpoint(JSON.parse(row.payload) as unknown),
        ),
        workflowRunId: row.workflowRunId,
      }
    })
  }

  public isTeamCompleted(state: CheckpointState, slug: string): boolean {
    return state.completedTeams.includes(slug)
  }

  public isMemberCompleted(state: CheckpointState, slug: string, login: string): boolean {
    return state.completedMemberPairs.includes(`${slug}:${login}`)
  }

  public markTeamCompleted(state: CheckpointState, slug: string): void {
    if (!this.isTeamCompleted(state, slug)) {
      state.completedTeams.push(slug)
    }
  }

  public markMemberCompleted(state: CheckpointState, slug: string, login: string): void {
    const pair = `${slug}:${login}`
    if (!state.completedMemberPairs.includes(pair)) {
      state.completedMemberPairs.push(pair)
    }
  }

  private async withDatabase<T>(
    use: (database: DatabaseSync) => T | Promise<T>,
  ): Promise<T> {
    await mkdir(path.dirname(this.databasePath), {recursive: true})
    const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const database = new DatabaseSync(this.databasePath)
    try {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      database.exec('PRAGMA busy_timeout = 5000')
      database.exec(`
        CREATE TABLE IF NOT EXISTS migration_checkpoints (
          run_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          configuration_hash TEXT NOT NULL,
          phase TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload TEXT NOT NULL
        ) STRICT
      `)
      database.exec(`
        CREATE TABLE IF NOT EXISTS migration_workflow_runs (
          migration_run_id TEXT PRIMARY KEY,
          workflow_run_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          workflow_status TEXT NOT NULL DEFAULT 'queued',
          report_path TEXT,
          report_kind TEXT CHECK(report_kind IN ('migration', 'escalation'))
        ) STRICT
      `)
      this.ensureColumn(
        database,
        'migration_workflow_runs',
        'workflow_status',
        "TEXT NOT NULL DEFAULT 'queued'",
      )
      this.ensureColumn(database, 'migration_workflow_runs', 'report_path', 'TEXT')
      this.ensureColumn(database, 'migration_workflow_runs', 'report_kind', 'TEXT')
      database.exec(`
        CREATE TABLE IF NOT EXISTS migration_elicitations (
          elicitation_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          workflow_run_id TEXT NOT NULL,
          hook_token TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('pending', 'resolved')),
          updated_at TEXT NOT NULL,
          resume_owner TEXT,
          resume_claimed_at TEXT,
          payload TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES migration_checkpoints(run_id)
        ) STRICT
      `)
      database.exec(`
        CREATE INDEX IF NOT EXISTS migration_elicitations_run_status
        ON migration_elicitations(run_id, status, updated_at)
      `)
      this.ensureColumn(
        database,
        'migration_elicitations',
        'resume_owner',
        'TEXT',
      )
      this.ensureColumn(
        database,
        'migration_elicitations',
        'resume_claimed_at',
        'TEXT',
      )
      database.exec(`
        CREATE TABLE IF NOT EXISTS migration_task_leases (
          task_key TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL
        ) STRICT
      `)
      return await use(database)
    } finally {
      database.close()
    }
  }

  private ensureColumn(
    database: DatabaseSync,
    table: string,
    column: string,
    definition: string,
  ): void {
    const columns = database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as Array<{name: string}>
    if (!columns.some((candidate) => candidate.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private async rejectLegacyCheckpoint(runId: string): Promise<void> {
    if (
      !this.legacyCheckpointDirectory ||
      path.basename(runId) !== runId
    ) {
      return
    }
    try {
      await readFile(
        path.join(this.legacyCheckpointDirectory, `${runId}.json`),
        'utf8',
      )
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError.code === 'ENOENT') {
        return
      }
      throw error
    }
    throw new Error(
      `Checkpoint ${runId} uses an unsupported schema version and cannot be resumed from legacy JSON state.`,
    )
  }
}
