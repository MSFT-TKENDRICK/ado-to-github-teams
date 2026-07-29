import type {World} from '@workflow/world'

type QueueFn = World['queue']

/** Minimal run listing shape the reconciler needs. */
export interface StrandedRunListing {
  readonly runId: string
  readonly workflowName: string
  readonly createdAt: Date | string | number
}

export interface StrandedRunsPage {
  readonly data: readonly StrandedRunListing[]
  readonly cursor?: string | null
  readonly hasMore?: boolean
}

/**
 * The narrow read surface the reconciler depends on: list pending runs without
 * resolving their input/output data. Satisfied by the composed World's SQLite
 * `runs` storage.
 */
export interface StrandedRunsReader {
  list(params: {
    readonly status: 'pending'
    readonly resolveData: 'none'
    readonly pagination: {cursor?: string}
  }): Promise<StrandedRunsPage>
}

export interface StrandedRunReconcilerConfig {
  readonly runs: StrandedRunsReader
  readonly queue: QueueFn
  /**
   * Only re-enqueue pending runs at least this old (ms). A freshly created run
   * is enqueued within milliseconds, so a grace period avoids racing the normal
   * start path and targets runs genuinely stranded by a crash between persist
   * and enqueue.
   */
  readonly minAgeMs?: number
  /** Maximum runs re-enqueued per tick, bounding recovery work. */
  readonly maxPerTick?: number
  readonly now?: () => number
  readonly log?: (message: string) => void
}

function workflowQueueName(workflowName: string): string {
  return `__wkf_workflow_${workflowName}`
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime()
  }
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    return new Date(value).getTime()
  }
  return Number.NaN
}

/**
 * Recovers workflow runs durably persisted to SQLite that may have been
 * stranded by a crash between the state persist and the queue enqueue. The
 * composed World spans SQLite and NATS JetStream, which cannot share a single
 * cross-store transaction, so `start()` persists a `pending` run row before it
 * publishes the queue message; a crash in between leaves a discoverable pending
 * row with no queue message.
 *
 * Detection is deterministic (list pending runs older than the grace period)
 * and re-enqueue is idempotent: a stable per-run idempotency key collapses
 * repeated ticks within the queue dedup window so a still-live run is not
 * delivered many times, and the workflow handler replays its event log, so a
 * re-enqueue never repeats verified destructive work.
 *
 * This is at-least-once recovery, not exactly-once delivery.
 *
 * @returns the number of runs re-enqueued this tick.
 */
export async function reconcileStrandedRuns(
  config: StrandedRunReconcilerConfig,
): Promise<number> {
  const now = config.now ?? (() => Date.now())
  const minAgeMs = config.minAgeMs ?? 60_000
  const maxPerTick = Math.max(1, config.maxPerTick ?? 100)
  const cutoff = now() - minAgeMs

  let reenqueued = 0
  let cursor: string | undefined
  let hasMore = true
  while (hasMore && reenqueued < maxPerTick) {
    const page = await config.runs.list({
      status: 'pending',
      resolveData: 'none',
      pagination: cursor ? {cursor} : {},
    })
    for (const run of page.data) {
      if (reenqueued >= maxPerTick) {
        break
      }
      const createdAtMs = toEpochMs(run.createdAt)
      if (Number.isFinite(createdAtMs) && createdAtMs > cutoff) {
        continue
      }
      try {
        await config.queue(
          workflowQueueName(run.workflowName),
          {runId: run.runId},
          {idempotencyKey: `recover:${run.runId}`},
        )
        reenqueued += 1
      } catch (error) {
        config.log?.(
          `Failed to re-enqueue stranded run ${run.runId}: ${String(error)}`,
        )
      }
    }
    cursor = page.cursor ?? undefined
    hasMore = (page.hasMore ?? false) && cursor !== undefined
  }

  if (reenqueued > 0) {
    config.log?.(`Re-enqueued ${reenqueued} stranded run(s)`)
  }
  return reenqueued
}

export interface StrandedRunReconcilerHandle {
  readonly stop: () => void
}

export interface StartStrandedRunReconcilerOptions
  extends StrandedRunReconcilerConfig {
  /** Interval between reconciler ticks (ms). */
  readonly intervalMs?: number
}

/**
 * Starts a periodic {@link reconcileStrandedRuns} loop. The timer is unref'd so
 * it never keeps the process alive, and overlapping ticks are suppressed.
 */
export function startStrandedRunReconciler(
  options: StartStrandedRunReconcilerOptions,
): StrandedRunReconcilerHandle {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 30_000)
  let running = false
  const tick = (): void => {
    if (running) {
      return
    }
    running = true
    void reconcileStrandedRuns(options)
      .catch((error: unknown) => {
        options.log?.(`Stranded-run reconciliation failed: ${String(error)}`)
      })
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}
