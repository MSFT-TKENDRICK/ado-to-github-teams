import {describe, expect, it} from 'vitest'
import {Effect, Layer} from 'effect'
import {
  advancePhase,
  fetchTeamsPhase,
  writeMigrationReport,
} from '../../../../src/effect/migration/phases.js'
import {ReportWriterTag} from '../../../../src/effect/services.js'
import type {ApprovalRecord, MigrationReport} from '../../../../src/types/index.js'
import {mappingLayer} from './test-layers.js'
import {checkpointState, memoryStateStore} from './test-state.js'

describe('migration phases', () => {
  it('fetches teams and advances only the fetch state', async () => {
    const memory = memoryStateStore(checkpointState({phase: 'fetch', mappings: []}))

    await Effect.runPromise(
      fetchTeamsPhase(
        memory.store,
        'Engineering',
        '2026-01-02T00:00:00.000Z',
      ).pipe(
        Effect.provide(
          mappingLayer({
            ado: {
              getTeams: () =>
                Effect.succeed([
                  {
                    id: 'team-2',
                    name: 'Infrastructure',
                    projectId: 'project-1',
                    projectName: 'Engineering',
                  },
                ]),
            },
          }),
        ),
      ),
    )

    expect(memory.state().phase).toBe('map')
    expect(memory.state().pendingTeams.map((team) => team.name)).toEqual([
      'Infrastructure',
    ])
  })

  it('snapshots approval history when advancing an apply phase', async () => {
    const approval: ApprovalRecord = {
      action: 'Create teams',
      context: '{}',
      approved: true,
      timestamp: '2026-01-01T00:00:00.000Z',
    }
    const memory = memoryStateStore(checkpointState({phase: 'dry-run'}))

    await Effect.runPromise(
      advancePhase(
        memory.store,
        'create-teams',
        '2026-01-02T00:00:00.000Z',
      ).pipe(
        Effect.provide(
          mappingLayer({
            approval: {history: Effect.succeed([approval])},
          }),
        ),
      ),
    )

    expect(memory.state().phase).toBe('create-teams')
    expect(memory.state().approvalHistory).toEqual([approval])
  })

  it('writes a report from the current checkpoint snapshot', async () => {
    const reports: MigrationReport[] = []
    const memory = memoryStateStore(checkpointState({phase: 'report'}))
    const layer = Layer.merge(
      mappingLayer(),
      Layer.succeed(ReportWriterTag, {
        write: (report) =>
          Effect.sync(() => {
            reports.push(report)
          }),
      }),
    )

    await Effect.runPromise(
      writeMigrationReport(memory.store, {
        dryRun: false,
        skippedItems: [],
        outputPath: 'report.md',
        durationMs: 10,
        timestamp: '2026-01-02T00:00:00.000Z',
      }).pipe(Effect.provide(layer)),
    )

    expect(reports[0]?.runId).toBe('run-1')
    expect(reports[0]?.dryRun).toBe(false)
  })
})
