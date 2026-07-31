import {Context, Data, Effect, Schema} from 'effect'

export const AzureSubscriptionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

export type AzureSubscription = typeof AzureSubscriptionSchema.Type

export const WorldSelectionSchema = Schema.Union(
  Schema.Struct({
    provider: Schema.Literal('local'),
  }),
  Schema.Struct({
    provider: Schema.Literal('azure'),
    subscriptionId: Schema.String,
    subscriptionName: Schema.String,
  }),
)

export type WorldSelection = typeof WorldSelectionSchema.Type

export class WorldSelectionFailure extends Data.TaggedError('WorldSelectionFailure')<{
  readonly operation:
    'choose-subscription' | 'list-subscriptions' | 'load-selection' | 'save-selection'
  readonly reason: string
}> {}

export interface AzureSubscriptionService {
  readonly list: Effect.Effect<readonly AzureSubscription[], WorldSelectionFailure>
}

export interface WorldSelectionStore {
  readonly load: Effect.Effect<WorldSelection, WorldSelectionFailure>
  readonly save: (selection: WorldSelection) => Effect.Effect<void, WorldSelectionFailure>
}

export class AzureSubscriptionServiceTag extends Context.Tag('AzureSubscriptionService')<
  AzureSubscriptionServiceTag,
  AzureSubscriptionService
>() {}

export class WorldSelectionStoreTag extends Context.Tag('WorldSelectionStore')<
  WorldSelectionStoreTag,
  WorldSelectionStore
>() {}

export type WorldSelectionRequest =
  {readonly provider: 'local'} | {readonly provider: 'azure'; readonly subscriptionId?: string}

export type WorldSelectionResult =
  | {
      readonly status: 'selected'
      readonly selection: WorldSelection
    }
  | {
      readonly status: 'azure-unavailable'
      readonly selection: Extract<WorldSelection, {provider: 'local'}>
    }
  | {
      readonly status: 'azure-subscription-inaccessible'
      readonly subscriptionId: string
      readonly selection: Extract<WorldSelection, {provider: 'local'}>
    }

export type ChooseAzureSubscription = (
  subscriptions: readonly AzureSubscription[],
) => Effect.Effect<AzureSubscription, WorldSelectionFailure>

const localSelection = {provider: 'local'} as const

export function findSubscription(
  subscriptions: readonly AzureSubscription[],
  subscriptionId: string,
): AzureSubscription | undefined {
  return subscriptions.find((subscription) => subscription.id === subscriptionId)
}

export function configureWorldSelection(
  request: WorldSelectionRequest,
  chooseSubscription: ChooseAzureSubscription,
): Effect.Effect<
  WorldSelectionResult,
  WorldSelectionFailure,
  AzureSubscriptionServiceTag | WorldSelectionStoreTag
> {
  return Effect.gen(function* () {
    const store = yield* WorldSelectionStoreTag
    if (request.provider === 'local') {
      yield* store.save(localSelection)
      return {status: 'selected', selection: localSelection} as const
    }

    const subscriptionService = yield* AzureSubscriptionServiceTag
    const subscriptions = yield* subscriptionService.list
    if (subscriptions.length === 0) {
      yield* store.save(localSelection)
      return {status: 'azure-unavailable', selection: localSelection} as const
    }

    const selected = request.subscriptionId
      ? findSubscription(subscriptions, request.subscriptionId)
      : yield* chooseSubscription(subscriptions)
    if (!selected) {
      yield* store.save(localSelection)
      return {
        status: 'azure-subscription-inaccessible',
        subscriptionId: request.subscriptionId ?? '',
        selection: localSelection,
      } as const
    }

    const selection = Schema.decodeUnknownSync(WorldSelectionSchema)({
      provider: 'azure',
      subscriptionId: selected.id,
      subscriptionName: selected.name,
    })
    yield* store.save(selection)
    return {status: 'selected', selection} as const
  })
}
