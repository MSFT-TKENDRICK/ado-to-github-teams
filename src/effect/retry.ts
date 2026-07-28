import {Duration, Effect, Schedule} from 'effect'
import {TransientFailure} from './errors.js'

export interface RetryPolicyOptions {
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
}

const defaults: Required<RetryPolicyOptions> = {
  maxAttempts: 5,
  baseDelayMs: 1000,
}

export function transientRetrySchedule(options: RetryPolicyOptions = {}) {
  const config = {...defaults, ...options}
  return Schedule.intersect(
    Schedule.recurs(config.maxAttempts - 1),
    Schedule.jittered(Schedule.exponential(Duration.millis(config.baseDelayMs))),
  )
}

export function retryTransient<A, E>(
  effect: Effect.Effect<A, E>,
  options: RetryPolicyOptions = {},
): Effect.Effect<A, E> {
  return effect.pipe(
    Effect.retry(
      transientRetrySchedule(options).pipe(
        Schedule.whileInput((error) => error instanceof TransientFailure),
      ),
    ),
  )
}
