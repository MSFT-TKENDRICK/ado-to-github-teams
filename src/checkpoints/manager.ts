import {mkdir, readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {homedir} from 'node:os'
import path from 'node:path'
import type {DatabaseSync} from 'node:sqlite'
import {Effect} from 'effect'
import {decodeCheckpoint} from '../effect/schemas.js'
import type {CheckpointState} from '../types/index.js'

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

export interface WorkflowRunSession extends LatestWorkflowRun {
  createdAt: string
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

  public async listWorkflowRuns(): Promise<WorkflowRunSession[]> {
    return this.withDatabase(async (database) => {
      const rows = database
        .prepare(
          `SELECT
             checkpoint.payload,
             workflow.workflow_run_id AS workflowRunId,
             workflow.created_at AS createdAt
           FROM migration_checkpoints AS checkpoint
           INNER JOIN migration_workflow_runs AS workflow
             ON workflow.migration_run_id = checkpoint.run_id
           ORDER BY checkpoint.updated_at DESC`,
        )
        .all() as unknown as Array<{
        payload: string
        workflowRunId: string
        createdAt: string
      }>
      return Promise.all(
        rows.map(async (row) => ({
          checkpoint: await Effect.runPromise(
            decodeCheckpoint(JSON.parse(row.payload) as unknown),
          ),
          workflowRunId: row.workflowRunId,
          createdAt: row.createdAt,
        })),
      )
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
          created_at TEXT NOT NULL
        ) STRICT
      `)
      return await use(database)
    } finally {
      database.close()
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
