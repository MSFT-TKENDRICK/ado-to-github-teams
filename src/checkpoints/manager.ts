import {mkdir} from 'node:fs/promises'
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

const DATABASE_FILENAME = 'workflow.db'

function resolveDatabasePath(location: string): string {
  return path.extname(location).toLowerCase() === '.db'
    ? location
    : path.join(location, DATABASE_FILENAME)
}

export class CheckpointManager {
  private readonly databasePath: string

  public constructor(
    location = path.join(homedir(), '.ado-github-teams', DATABASE_FILENAME),
  ) {
    this.databasePath = resolveDatabasePath(location)
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
    return this.withDatabase(async (database) => {
      const row = database
        .prepare('SELECT payload FROM migration_checkpoints WHERE run_id = ?')
        .get(runId) as {payload: string} | undefined
      if (!row) {
        return null
      }

      const raw = JSON.parse(row.payload) as unknown
      return Effect.runPromise(decodeCheckpoint(raw))
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
      return await use(database)
    } finally {
      database.close()
    }
  }
}
