import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {AzureSubscriptionServiceTag} from '../../../src/workflow/selection.js'
import {makeAzureSubscriptionLayer} from '../../../src/workflow/selection-live.js'

describe('Azure subscription adapter', () => {
  it('returns only schema-valid enabled subscriptions', async () => {
    const layer = makeAzureSubscriptionLayer({
      authenticationManager: {
        resolveAzureCredential: () =>
          Promise.resolve({
            getToken: () => Promise.resolve(null),
          }),
      },
      createClient: () => ({
        subscriptions: {
          list: async function* () {
            yield {
              subscriptionId: 'enabled-1',
              displayName: 'Enabled',
              state: 'Enabled',
            }
            yield {
              subscriptionId: 'disabled-1',
              displayName: 'Disabled',
              state: 'Disabled',
            }
            yield {
              subscriptionId: 'missing-name',
              state: 'Enabled',
            }
          },
        },
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AzureSubscriptionServiceTag
        return yield* service.list
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual([{id: 'enabled-1', name: 'Enabled'}])
  })

  it('translates authentication and ARM failures to bounded adapter errors', async () => {
    const layer = makeAzureSubscriptionLayer({
      authenticationManager: {
        resolveAzureCredential: () => Promise.reject(new Error('sensitive provider response')),
      },
    })

    const result = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const service = yield* AzureSubscriptionServiceTag
          return yield* service.list
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left).toMatchObject({
        _tag: 'WorldSelectionFailure',
        operation: 'list-subscriptions',
        reason: 'azure-request-failed',
      })
      expect(JSON.stringify(result.left)).not.toContain('sensitive provider response')
    }
  })
})
