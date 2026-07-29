import {Effect, Ref} from 'effect'

/**
 * Bounds a single apply invocation to a small, resumable slice of destructive
 * work. Each destructive unit calls {@link ApplyBudget.consume} before issuing
 * its write; when the unit count or the soft wall-clock deadline is reached the
 * phase stops at a checkpoint boundary and the caller reports a continuation so
 * the durable workflow re-invokes for the next slice.
 *
 * The soft deadline is set below the caller's HTTP timeout so a worker never
 * keeps initiating mutations after the caller has already given up.
 */
export interface ApplyBudget {
  /** Reserve one destructive unit. Returns false (and latches exhaustion) when the batch is full. */
  readonly consume: Effect.Effect<boolean>
  /** True once the batch stopped early because a bound was hit. */
  readonly wasExhausted: Effect.Effect<boolean>
}

export interface ApplyBatchLimits {
  /** Maximum destructive units per invocation. Clamped to >= 1 so progress is always made. */
  readonly maxUnits?: number
  /** Soft wall-clock budget in milliseconds; keep strictly below the caller timeout. */
  readonly softDeadlineMs?: number
}

export interface MakeApplyBudgetOptions extends ApplyBatchLimits {
  readonly startedAtMs?: number
  readonly now?: () => number
}

/**
 * Builds an {@link ApplyBudget}. With no limits it never exhausts, preserving
 * single-shot behaviour for callers (and tests) that do not batch.
 */
export function makeApplyBudget(options: MakeApplyBudgetOptions = {}): Effect.Effect<ApplyBudget> {
  return Effect.gen(function* () {
    const clock = options.now ?? (() => Date.now())
    const startedAt = options.startedAtMs ?? clock()
    const maxUnits =
      options.maxUnits !== undefined && Number.isFinite(options.maxUnits)
        ? Math.max(1, Math.floor(options.maxUnits))
        : Number.POSITIVE_INFINITY
    const deadline =
      options.softDeadlineMs !== undefined && options.softDeadlineMs > 0
        ? startedAt + options.softDeadlineMs
        : Number.POSITIVE_INFINITY
    const remainingRef = yield* Ref.make(maxUnits)
    const exhaustedRef = yield* Ref.make(false)

    const consume = Effect.gen(function* () {
      const remaining = yield* Ref.get(remainingRef)
      const outOfTime = clock() >= deadline
      if (remaining <= 0 || outOfTime) {
        yield* Ref.set(exhaustedRef, true)
        return false
      }
      yield* Ref.set(remainingRef, remaining - 1)
      return true
    })

    return {consume, wasExhausted: Ref.get(exhaustedRef)}
  })
}
