import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  makeApprovalLayer,
  makeCheckpointLayer,
  makeWorkflowApprovalLayer,
  ReportWriterLiveLayer,
} from '../../src/effect/layers.js'
import {ApprovalServiceTag, CheckpointStoreTag, ReportWriterTag} from '../../src/effect/services.js'
import {CheckpointManager} from '../../src/checkpoints/manager.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointState,
  type MigrationReport,
} from '../../src/types/index.js'

function checkpointFixture(): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash: 'configuration-hash',
    runId: 'run-1',
    timestamp: '2026-07-28T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    migrationConfig: {
      apply: false,
      prefix: '',
      suffix: '',
    },
    phase: 'fetch',
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

function reportFixture(): MigrationReport {
  return {
    runId: 'run-1',
    timestamp: '2026-07-28T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    dryRun: true,
    mappings: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

describe('live Effect boundary layers', () => {
  it('round-trips, lists, and deletes checkpoint files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ado-gh-effect-checkpoints-'))
    try {
      const program = Effect.gen(function* () {
        const checkpoints = yield* CheckpointStoreTag
        const state = checkpointFixture()
        yield* checkpoints.save(state)
        const loaded = yield* checkpoints.load(state.runId)
        const latest = yield* checkpoints.latest
        const listed = yield* checkpoints.list
        yield* checkpoints.delete(state.runId)
        const deleted = yield* checkpoints.load(state.runId)
        return {loaded, latest, listed, deleted}
      })

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(makeCheckpointLayer(directory))),
      )

      expect(result.loaded).toEqual(checkpointFixture())
      expect(result.latest).toEqual(checkpointFixture())
      expect(result.listed).toEqual([
        {
          runId: 'run-1',
          timestamp: '2026-07-28T00:00:00.000Z',
          phase: 'fetch',
        },
      ])
      expect(result.deleted).toBeNull()
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  it('rejects unversioned checkpoints instead of resuming with ambiguous scope', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ado-gh-legacy-checkpoints-'))
    try {
      const legacy = {
        ...checkpointFixture(),
        schemaVersion: undefined,
        apply: undefined,
      }
      await writeFile(path.join(directory, 'legacy-run.json'), JSON.stringify(legacy), 'utf8')

      await expect(new CheckpointManager(directory).load('legacy-run')).rejects.toThrow(
        'unsupported schema version',
      )
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  it('writes migration reports through the live filesystem adapter', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ado-gh-effect-reports-'))
    const output = path.join(directory, 'report.md')
    try {
      const program = Effect.gen(function* () {
        const writer = yield* ReportWriterTag
        yield* writer.write(reportFixture(), output, 25)
      })

      await Effect.runPromise(program.pipe(Effect.provide(ReportWriterLiveLayer)))
      const markdown = await readFile(output, 'utf8')
      expect(markdown).toContain('## Run Summary')
      expect(markdown).toContain('run-1')
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })

  it('records auto-approvable decisions in the approval boundary', async () => {
    const program = Effect.gen(function* () {
      const approval = yield* ApprovalServiceTag
      const approved = yield* approval.request({
        action: 'Continue read-only discovery',
        context: {phase: 'fetch'},
        displayLines: ['Fetch teams'],
        autoApprovable: true,
      })
      return {approved, history: yield* approval.history}
    })

    const result = await Effect.runPromise(program.pipe(Effect.provide(makeApprovalLayer(true))))
    expect(result.approved).toBe(true)
    expect(result.history).toHaveLength(1)
    expect(result.history[0]).toMatchObject({
      action: 'Continue read-only discovery',
      approved: true,
    })
  })

  it('does not reuse plan approval for an inferred recovery decision', async () => {
    const program = Effect.gen(function* () {
      const approval = yield* ApprovalServiceTag
      const plannedWrite = yield* approval.request({
        action: 'Add 1 members across 1 teams',
        context: {memberCount: 1, teamCount: 1},
        displayLines: ['platform:ada'],
        autoApprovable: false,
      })
      const inferredSkip = yield* approval.request({
        action: 'Skip failed assign-member per Copilot recommendation',
        context: {target: 'platform:ada'},
        displayLines: ['Manual review required'],
        autoApprovable: false,
      })
      return {plannedWrite, inferredSkip, history: yield* approval.history}
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          makeWorkflowApprovalLayer(true, [
            {
              action: 'Apply migration',
              context: '{}',
              approved: true,
              timestamp: '2026-07-29T00:00:00.000Z',
            },
          ]),
        ),
      ),
    )

    expect(result.plannedWrite).toBe(true)
    expect(result.inferredSkip).toBe(false)
    expect(result.history.at(-1)).toMatchObject({
      action: 'Skip failed assign-member per Copilot recommendation',
      approved: false,
    })
  })
})
