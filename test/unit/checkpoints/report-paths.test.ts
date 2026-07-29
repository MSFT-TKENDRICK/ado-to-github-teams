import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {describe, expect, it} from 'vitest'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import {CHECKPOINT_SCHEMA_VERSION, type CheckpointState} from '../../../src/types/index.js'

function checkpoint(runId: string): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: `hash-${runId}`,
    runId,
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    migrationConfig: {apply: true, prefix: '', suffix: '', concurrency: 4},
    phase: 'create-teams',
    completedTeams: [],
    completedMemberPairs: [],
    pendingTeams: [],
    mappings: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

async function tempDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'report-paths-'))
  return path.join(directory, 'workflow.db')
}

/**
 * Directly seeds a `migration_workflow_runs` row the way a pre-migration build of this app would
 * have (only the legacy, ambiguous `report_path`/`report_kind` pair populated; the new
 * `migration_report_path`/`escalation_report_path` columns never written). Used to prove the
 * schema migration/backfill in `CheckpointManager.withDatabase()` is backward compatible with
 * rows persisted before this change shipped.
 */
async function seedLegacyRow(
  databasePath: string,
  runId: string,
  workflowRunId: string,
  reportPath: string,
  reportKind: 'migration' | 'escalation',
): Promise<void> {
  const {DatabaseSync} = createRequire(import.meta.url)(
    'node:sqlite',
  ) as typeof import('node:sqlite')
  const database = new DatabaseSync(databasePath)
  try {
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
    database
      .prepare(
        `INSERT INTO migration_workflow_runs (
          migration_run_id, workflow_run_id, created_at, workflow_status, report_path, report_kind
        ) VALUES (?, ?, ?, 'completed', ?, ?)`,
      )
      .run(runId, workflowRunId, '2026-01-01T00:00:00.000Z', reportPath, reportKind)
  } finally {
    database.close()
  }
}

describe('migration/escalation report path separation', () => {
  it('never lets an escalation outcome overwrite a previously recorded migration report path', async () => {
    const manager = new CheckpointManager(await tempDatabasePath())
    await manager.linkWorkflow({
      migrationRunId: 'run-a',
      workflowRunId: 'workflow-a',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    await manager.recordWorkflowOutcome(
      'run-a',
      'completed',
      '/data/reports/migration-report-run-a.md',
      'migration',
    )
    await manager.recordWorkflowOutcome(
      'run-a',
      'escalated',
      '/data/reports/migration-escalation-run-a-elicit-1.md',
      'escalation',
    )

    expect(await manager.getMigrationReportPath('run-a')).toBe(
      '/data/reports/migration-report-run-a.md',
    )
    expect(await manager.getEscalationReportPath('run-a')).toBe(
      '/data/reports/migration-escalation-run-a-elicit-1.md',
    )
  })

  it('never lets a migration report overwrite a previously recorded escalation dossier path', async () => {
    const manager = new CheckpointManager(await tempDatabasePath())
    await manager.linkWorkflow({
      migrationRunId: 'run-b',
      workflowRunId: 'workflow-b',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    await manager.recordWorkflowOutcome(
      'run-b',
      'escalated',
      '/data/reports/migration-escalation-run-b-elicit-1.md',
      'escalation',
    )
    await manager.recordWorkflowOutcome(
      'run-b',
      'completed',
      '/data/reports/migration-report-run-b.md',
      'migration',
    )

    expect(await manager.getEscalationReportPath('run-b')).toBe(
      '/data/reports/migration-escalation-run-b-elicit-1.md',
    )
    expect(await manager.getMigrationReportPath('run-b')).toBe(
      '/data/reports/migration-report-run-b.md',
    )
  })

  it('never returns an escalation dossier through the migration-only report getter (no dossier exposure through the normal report endpoint)', async () => {
    const manager = new CheckpointManager(await tempDatabasePath())
    await manager.linkWorkflow({
      migrationRunId: 'run-c',
      workflowRunId: 'workflow-c',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    // Only an escalation dossier was ever recorded for this run (e.g. the migration blocked
    // before completing). `GET /api/migrations/:runId/report` in src/worker.ts calls exactly
    // this getter, so this proves the sensitive dossier can never be served through it.
    await manager.recordWorkflowOutcome(
      'run-c',
      'escalated',
      '/data/reports/migration-escalation-run-c-elicit-1.md',
      'escalation',
    )

    expect(await manager.getMigrationReportPath('run-c')).toBeNull()
    expect(await manager.getEscalationReportPath('run-c')).toBe(
      '/data/reports/migration-escalation-run-c-elicit-1.md',
    )
  })

  it('returns null for both getters when no report of either kind was ever recorded', async () => {
    const manager = new CheckpointManager(await tempDatabasePath())
    await manager.linkWorkflow({
      migrationRunId: 'run-d',
      workflowRunId: 'workflow-d',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    expect(await manager.getMigrationReportPath('run-d')).toBeNull()
    expect(await manager.getEscalationReportPath('run-d')).toBeNull()
  })

  it('backfills dedicated report path columns for rows persisted before this schema change (backward compatibility)', async () => {
    const databasePath = await tempDatabasePath()
    await seedLegacyRow(
      databasePath,
      'legacy-migration-run',
      'legacy-migration-workflow',
      '/data/reports/migration-report-legacy-migration-run.md',
      'migration',
    )
    await seedLegacyRow(
      databasePath,
      'legacy-escalation-run',
      'legacy-escalation-workflow',
      '/data/reports/migration-escalation-legacy-escalation-run.md',
      'escalation',
    )

    // Opening the manager against the pre-existing database file triggers ensureColumn() and the
    // idempotent backfill UPDATEs the very first time withDatabase() runs.
    const manager = new CheckpointManager(databasePath)
    await manager.save(checkpoint('legacy-migration-run'))
    await manager.save(checkpoint('legacy-escalation-run'))

    expect(await manager.getMigrationReportPath('legacy-migration-run')).toBe(
      '/data/reports/migration-report-legacy-migration-run.md',
    )
    expect(
      await manager.getEscalationReportPath('legacy-migration-run'),
    ).toBeNull()

    expect(
      await manager.getEscalationReportPath('legacy-escalation-run'),
    ).toBe('/data/reports/migration-escalation-legacy-escalation-run.md')
    expect(
      await manager.getMigrationReportPath('legacy-escalation-run'),
    ).toBeNull()

    // listWorkflowSessions()'s reportKind field (existing back-compat contract) must still work
    // off the legacy pair, unaffected by the new dedicated columns.
    const sessions = await manager.listWorkflowSessions()
    expect(
      sessions.find((session) => session.runId === 'legacy-migration-run'),
    ).toMatchObject({reportKind: 'migration'})
    expect(
      sessions.find((session) => session.runId === 'legacy-escalation-run'),
    ).toMatchObject({reportKind: 'escalation'})
  })
})
