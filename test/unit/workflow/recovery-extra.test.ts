import type {World} from '@workflow/world'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  reconcileStrandedRuns,
  startStrandedRunReconciler,
  type StrandedRunListing,
  type StrandedRunsPage,
  type StrandedRunsReader,
} from '../../../src/workflow/recovery.js'

const NOW = Date.parse('2026-07-29T12:00:00.000Z')

interface QueueCall {
  readonly message: unknown
  readonly idempotencyKey: string | undefined
}

function recordingQueue(failFor: ReadonlySet<string> = new Set()): {
  queue: World['queue']
  calls: QueueCall[]
} {
  const calls: QueueCall[] = []
  const queue: World['queue'] = (_name, message, opts) => {
    const runId = (message as {runId?: string}).runId ?? ''
    calls.push({message, idempotencyKey: opts?.idempotencyKey})
    if (failFor.has(runId)) {
      return Promise.reject(new Error(`enqueue failed for ${runId}`))
    }
    return Promise.resolve({messageId: null})
  }
  return {queue, calls}
}

function singlePageReader(runs: readonly StrandedRunListing[]): StrandedRunsReader {
  return {
    list: () => Promise.resolve({data: [...runs], cursor: null, hasMore: false}),
  }
}

function listing(runId: string, createdAt: Date | string | number): StrandedRunListing {
  return {runId, workflowName: 'migrationWorkflow', createdAt}
}

describe('reconcileStrandedRuns — createdAt coercion', () => {
  it('re-enqueues a run whose createdAt is a numeric epoch older than the cutoff', async () => {
    const {queue, calls} = recordingQueue()
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([listing('numeric', NOW - 120_000)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    expect(reenqueued).toBe(1)
    expect(calls[0]?.idempotencyKey).toBe('recover:numeric')
  })

  it('re-enqueues a run whose createdAt is an ISO string older than the cutoff', async () => {
    const {queue, calls} = recordingQueue()
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([listing('iso', new Date(NOW - 120_000).toISOString())]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    expect(reenqueued).toBe(1)
    expect(calls[0]?.message).toEqual({runId: 'iso'})
  })

  it('treats an uncoercible createdAt as stranded and re-enqueues it', async () => {
    const {queue, calls} = recordingQueue()
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([listing('garbage', null as unknown as Date)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    expect(reenqueued).toBe(1)
    expect(calls).toHaveLength(1)
  })
})

describe('reconcileStrandedRuns — logging', () => {
  it('logs a summary line after re-enqueuing stranded runs', async () => {
    const {queue} = recordingQueue()
    const log = vi.fn()
    await reconcileStrandedRuns({
      runs: singlePageReader([listing('stranded', NOW - 120_000)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
      log,
    })

    expect(log).toHaveBeenCalledWith('Re-enqueued 1 stranded run(s)')
  })

  it('logs a bounded failure line when an individual enqueue rejects', async () => {
    const {queue} = recordingQueue(new Set(['b']))
    const log = vi.fn()
    const reenqueued = await reconcileStrandedRuns({
      runs: singlePageReader([listing('b', NOW - 120_000)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
      log,
    })

    expect(reenqueued).toBe(0)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Failed to re-enqueue stranded run b: Error: enqueue failed for b'),
    )
  })
})

describe('startStrandedRunReconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a reconciliation tick on the clamped interval and stops cleanly', async () => {
    const {queue, calls} = recordingQueue()
    const log = vi.fn()
    const handle = startStrandedRunReconciler({
      runs: singlePageReader([listing('stranded', NOW - 120_000)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
      log,
      intervalMs: 10,
    })

    // The interval is clamped to a 1s floor, so nothing fires before 1000ms.
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(log).toHaveBeenCalledWith('Re-enqueued 1 stranded run(s)')

    handle.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(1)
  })

  it('defaults to a 30s interval when none is supplied', async () => {
    const {queue, calls} = recordingQueue()
    const handle = startStrandedRunReconciler({
      runs: singlePageReader([listing('stranded', NOW - 120_000)]),
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
    })

    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)

    handle.stop()
  })

  it('suppresses an overlapping tick while a reconciliation is still in flight', async () => {
    let resolveList: (page: StrandedRunsPage) => void = () => {}
    const listPromise = new Promise<StrandedRunsPage>((resolve) => {
      resolveList = resolve
    })
    let listCalls = 0
    const reader: StrandedRunsReader = {
      list: () => {
        listCalls += 1
        return listPromise
      },
    }
    const {queue, calls} = recordingQueue()
    const handle = startStrandedRunReconciler({
      runs: reader,
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
      intervalMs: 1_000,
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(listCalls).toBe(1)

    // Second tick fires while the first reconcile is still awaiting the reader.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listCalls).toBe(1)

    resolveList({data: [listing('stranded', NOW - 120_000)], cursor: null, hasMore: false})
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    // With the in-flight reconcile finished, the next tick runs again.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listCalls).toBe(2)

    handle.stop()
  })

  it('logs and recovers when a reconciliation tick rejects', async () => {
    const {queue} = recordingQueue()
    const log = vi.fn()
    const reader: StrandedRunsReader = {
      list: () => Promise.reject(new Error('sqlite unavailable')),
    }
    const handle = startStrandedRunReconciler({
      runs: reader,
      queue,
      minAgeMs: 60_000,
      now: () => NOW,
      log,
      intervalMs: 1_000,
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Stranded-run reconciliation failed: Error: sqlite unavailable'),
    )

    handle.stop()
  })
})
