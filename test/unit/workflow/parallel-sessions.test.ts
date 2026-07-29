import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import {checkpointState} from '../effect/migration/test-state.js'
import {registerApplyElicitation} from '../../../src/workflow/elicitations.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {recursive: true, force: true}),
    ),
  )
})

describe('parallel durable session inbox', () => {
  it('lists blocking elicitations from independently progressing sessions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'parallel-sessions-'))
    directories.push(directory)
    const manager = new CheckpointManager(path.join(directory, 'workflow.db'))
    const sessions = ['run-a', 'run-b', 'run-c'].map((runId, index) => {
      const state = checkpointState({
        runId,
        phase: index === 2 ? 'map' : 'dry-run',
        timestamp: `2026-07-29T14:0${index}:00.000Z`,
      })
      return index === 2
        ? state
        : registerApplyElicitation(state, state.timestamp)
    })

    await Promise.all(
      sessions.map(async (state, index) => {
        await manager.save(state)
        await manager.linkWorkflow({
          migrationRunId: state.runId,
          workflowRunId: `workflow-${index}`,
          createdAt: state.timestamp,
        })
      }),
    )

    const listed = await manager.listWorkflowRuns()
    const blocked = listed.filter((session) =>
      (session.checkpoint.elicitations ?? []).some(
        (elicitation) => elicitation.status === 'pending',
      ),
    )

    expect(listed.map((session) => session.checkpoint.runId)).toEqual([
      'run-c',
      'run-b',
      'run-a',
    ])
    expect(blocked.map((session) => session.checkpoint.runId)).toEqual([
      'run-b',
      'run-a',
    ])
    expect(
      blocked.flatMap(
        (session) => session.checkpoint.elicitations ?? [],
      ),
    ).toHaveLength(2)
  })
})
