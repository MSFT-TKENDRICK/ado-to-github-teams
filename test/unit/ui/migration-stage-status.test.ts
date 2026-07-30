import {describe, expect, it} from 'vitest'
import {
  migrationStageStatus,
  renderMigrationStageStatus,
} from '../../../src/ui/migration-stage-status.js'

describe('migration stage status', () => {
  it('describes the current stage and what will happen next', () => {
    const status = migrationStageStatus({
      runId: 'run-1',
      phase: 'assign-members',
      workflowStatus: 'running',
      updatedAt: '2026-07-29T12:00:00.000Z',
    })

    expect(status).toEqual({
      runId: 'run-1',
      state: 'Running',
      currentStage: 'Assigning team members',
      nextEvent: 'Repository permissions are applied after membership assignments.',
      lastUpdated: '2026-07-29T12:00:00.000Z',
    })
  })

  it('makes blocking decisions and their recovery path explicit', () => {
    const lines = renderMigrationStageStatus({
      runId: 'run-blocked',
      phase: 'create-teams',
      workflowStatus: 'running',
      blockingCount: 2,
    })

    expect(lines).toContain('Status: Blocked (2 decisions needed)')
    expect(lines).toContain('Current stage: Creating GitHub teams')
    expect(lines).toContain(
      'Next event: Resolve the blocking decision in the session inbox to continue.',
    )
    expect(lines).toContain('Last update: Pending first worker update')
  })

  it('surfaces unrecognized worker stages instead of presenting a false milestone', () => {
    const status = migrationStageStatus({
      runId: 'run-new-worker',
      phase: 'provider-extension',
      workflowStatus: 'running',
    })

    expect(status.currentStage).toBe('Unrecognized worker stage (provider-extension)')
    expect(status.nextEvent).toContain('inspect the worker')
  })

  it('renders the same stage facts on one scan-friendly compact line', () => {
    const lines = renderMigrationStageStatus(
      {
        runId: 'run-compact',
        phase: 'assign-members',
        workflowStatus: 'running',
        updatedAt: '2026-07-29T12:00:00.000Z',
      },
      'compact',
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[Running] run-compact')
    expect(lines[0]).toContain('Assigning team members')
    expect(lines[0]).toContain('Next: Repository permissions')
    expect(lines[0]).toContain('Updated: 2026-07-29T12:00:00.000Z')
  })
})
