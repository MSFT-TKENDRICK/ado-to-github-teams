import {describe, expect, it} from 'vitest'
import {Effect, Ref} from 'effect'
import {TransientFailure, ValidationFailure} from '../../../src/effect/errors.js'
import {retryTransient} from '../../../src/effect/retry.js'

describe('retryTransient', () => {
  it('retries transient failures', async () => {
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const effect = Ref.updateAndGet(attempts, (value) => value + 1).pipe(
        Effect.flatMap((count) => {
          if (count < 3) {
            return Effect.fail(
              new TransientFailure({
                service: 'github',
                message: 'retryable',
                status: 503,
              }),
            )
          }
          return Effect.succeed(count)
        }),
      )
      return yield* retryTransient(effect, {maxAttempts: 5, baseDelayMs: 1})
    })

    const count = await Effect.runPromise(program)
    expect(count).toBe(3)
  })

  it('does not retry non-transient failures', async () => {
    const effect = Effect.fail(
      new ValidationFailure({
        service: 'github',
        message: 'not retryable',
        status: 422,
      }),
    )

    await expect(
      Effect.runPromise(retryTransient(effect, {maxAttempts: 5, baseDelayMs: 1})),
    ).rejects.toThrow('not retryable')
  })
})
