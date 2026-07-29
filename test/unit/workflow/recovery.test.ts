import type {World} from '@workflow/world'
import {describe, expect, it} from 'vitest'
import {
  reconcileStrandedRuns,
  type StrandedRunListing,
  type StrandedRunsReader,
} from '../../../src/workflow/recovery.js'

const NOW = Date.parse('2026-07-29T12:00:00.000Z')

interface QueueCall {
  readonly name: unknown
  readonly message: unknown
  readonly idempotencyKey: string | undefined
}

function recordingQueue(failFor: ReadonlySet<string> = new Set()): {
  queue: World['queue']
  calls: QueueCall[]
} {
  const calls: QueueCall[] = []
  const queue: World['queue'] = (name, message, opts) => {
    const runId = (message as {runId?: string}).runId ?? ''
    calls.push({name, message, idempotencyKey: opts?.idempotencyKey})
    if (failFor.has(runId)) {
      return Promise.reject(new Error(`enqueue failed for ${runId}`))
    }
    return Promise.resolve({messageId: null})
  }
  return {queue, calls}
}

function singlePageReader(runs: readonly StrandedRunListing[]): StrandedRunsReader {
  return {
    list: () =>
      Promise.resolve({data: [...runs], cursor: null, hasMore: false}),
  }
}

function run(
  runId: string,
  ageMs: number,
  workflowName = 'migrationWorkflow',
): StrandedRunListing {
  return {runId, workflowName, createdAt: new Date(NOW - ageMs)}
}

describe('reconcileStrandedRuns', () => {
  it('re-enqueues a stranded pending run older than the grace period with a stable key', async () => {
    const {queue, calls} = recordingQueue()
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([run('stranded', 120_000)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    expect(reenqueued).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('__wkf_workflow_migrationWorkflow')
    expect(calls[0]?.message).toEqual({runId: 'stranded'})
    expect(calls[0]?.idempotencyKey).toBe('recover:stranded')
  })

  it('does not re-enqueue a freshly persisted run inside the grace period', async () => {
    const {queue, calls} = recordingQueue()
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([run('fresh', 5_000)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    expect(reenqueued).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('uses an identical idempotency key across repeated ticks so duplicate delivery is suppressed', async () => {
    const {queue, calls} = recordingQueue()
    const reader = singlePageReader([run('stranded', 120_000)])
    const options = {runs: reader, queue, minAgeMs: 60_000, now: () => NOW}

    await reconcileStrandedRuns(options)
    await reconcileStrandedRuns(options)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.idempotencyKey).toBe('recover:stranded')
    expect(calls[1]?.idempotencyKey).toBe('recover:stranded')
  })

  it('bounds work to maxPerTick', async () => {
    const {queue, calls} = recordingQueue()
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([
        run('a', 120_000),
        run('b', 120_000),
        run('c', 120_000),
      ]),
      queue,
      minAgeMs: 60_000,
      maxPerTick: 2,
      now: () => NOW,
    })

    expect(reenqueued).toBe(2)
    expect(calls).toHaveLength(2)
  })

  it('continues past a single enqueue failure and counts only successes', async () => {
    const {queue, calls} = recordingQueue(new Set(['b']))
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([
        run('a', 120_000),
        run('b', 120_000),
        run('c', 120_000),
      ]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    expect(reenqueued).toBe(2)
    expect(calls.map((call) => (call.message as {runId: string}).runId)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('walks pagination until the cursor is exhausted', async () => {
    const pages: Array<{
      data: StrandedRunListing[]
      cursor: string | null
      hasMore: boolean
    }> = [
      {data: [run('a', 120_000)], cursor: 'page-2', hasMore: true},
      {data: [run('b', 120_000)], cursor: null, hasMore: false},
    ]
    let index = 0
    const reader: StrandedRunsReader = {
      list: () => {
        const page = pages[index] ?? {data: [], cursor: null, hasMore: false}
        index += 1
        return Promise.resolve(page)
      },
    }
    const {queue, calls} = recordingQueue()
    const reenqueued = await reconcileStrandedRuns({
      runs: reader,
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    expect(reenqueued).toBe(2)
    expect(calls.map((call) => (call.message as {runId: string}).runId)).toEqual([
      'a',
      'b',
    ])
  })
})
