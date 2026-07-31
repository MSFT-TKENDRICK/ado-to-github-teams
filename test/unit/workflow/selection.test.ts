import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  AzureSubscriptionServiceTag,
  configureWorldSelection,
  WorldSelectionStoreTag,
  type AzureSubscription,
  type WorldSelection,
} from '../../../src/workflow/selection.js'

const subscriptions: readonly AzureSubscription[] = [
  {id: 'subscription-1', name: 'Engineering'},
  {id: 'subscription-2', name: 'Research'},
]

function testLayer(options: {
  readonly subscriptions: readonly AzureSubscription[]
  readonly onList?: () => void
  readonly saved: WorldSelection[]
}) {
  return Layer.merge(
    Layer.succeed(AzureSubscriptionServiceTag, {
      list: Effect.sync(() => {
        options.onList?.()
        return options.subscriptions
      }),
    }),
    Layer.succeed(WorldSelectionStoreTag, {
      load: Effect.succeed({provider: 'local'} as const),
      save: (selection) =>
        Effect.sync(() => {
          options.saved.push(selection)
        }),
    }),
  )
}

describe('World selection', () => {
  it('selects local without authentication, subscription discovery, or prompting', async () => {
    let listCalls = 0
    let promptCalls = 0
    const saved: WorldSelection[] = []

    const result = await Effect.runPromise(
      configureWorldSelection({provider: 'local'}, () =>
        Effect.sync(() => {
          promptCalls += 1
          return subscriptions[0]!
        }),
      ).pipe(
        Effect.provide(
          testLayer({
            subscriptions,
            saved,
            onList: () => {
              listCalls += 1
            },
          }),
        ),
      ),
    )

    expect(result).toEqual({status: 'selected', selection: {provider: 'local'}})
    expect(listCalls).toBe(0)
    expect(promptCalls).toBe(0)
    expect(saved).toEqual([{provider: 'local'}])
  })

  it('keeps local selected when the signed-in account has no enabled subscription', async () => {
    const saved: WorldSelection[] = []

    const result = await Effect.runPromise(
      configureWorldSelection({provider: 'azure'}, () => Effect.succeed(subscriptions[0]!)).pipe(
        Effect.provide(testLayer({subscriptions: [], saved})),
      ),
    )

    expect(result).toEqual({
      status: 'azure-unavailable',
      selection: {provider: 'local'},
    })
    expect(saved).toEqual([{provider: 'local'}])
  })

  it('keeps local selected when a requested subscription is inaccessible', async () => {
    const saved: WorldSelection[] = []

    const result = await Effect.runPromise(
      configureWorldSelection({provider: 'azure', subscriptionId: 'missing'}, () =>
        Effect.succeed(subscriptions[0]!),
      ).pipe(Effect.provide(testLayer({subscriptions, saved}))),
    )

    expect(result).toEqual({
      status: 'azure-subscription-inaccessible',
      subscriptionId: 'missing',
      selection: {provider: 'local'},
    })
    expect(saved).toEqual([{provider: 'local'}])
  })

  it('persists Azure only after an accessible subscription is explicitly selected', async () => {
    const saved: WorldSelection[] = []

    const result = await Effect.runPromise(
      configureWorldSelection({provider: 'azure'}, () => Effect.succeed(subscriptions[1]!)).pipe(
        Effect.provide(testLayer({subscriptions, saved})),
      ),
    )

    const selection = {
      provider: 'azure',
      subscriptionId: 'subscription-2',
      subscriptionName: 'Research',
    } as const
    expect(result).toEqual({status: 'selected', selection})
    expect(saved).toEqual([selection])
  })
})
