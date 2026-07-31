import {select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import {Effect, Layer} from 'effect'
import {
  configureWorldSelection,
  type AzureSubscription,
  WorldSelectionFailure,
  WorldSelectionStoreTag,
} from '../workflow/selection.js'
import {
  makeAzureSubscriptionLayer,
  makeWorldSelectionStoreLayer,
} from '../workflow/selection-live.js'

export default class World extends Command {
  static override description = 'Record a local preference or run the Azure deployment preflight'

  static override flags = {
    local: Flags.boolean({
      description: 'Record the local preference without signing into Azure',
      default: false,
      exclusive: ['subscription'],
    }),
    subscription: Flags.string({
      description: 'Validate and record an accessible Azure subscription by ID',
      required: false,
      exclusive: ['local'],
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(World)
    const layer = Layer.merge(makeAzureSubscriptionLayer(), makeWorldSelectionStoreLayer())
    let provider: 'local' | 'azure'
    if (flags.local || flags.subscription) {
      provider = flags.local ? 'local' : 'azure'
    } else {
      const current = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* WorldSelectionStoreTag
          return yield* store.load
        }).pipe(Effect.provide(layer)),
      )
      this.log(
        current.provider === 'local'
          ? 'Current deployment preference: local.'
          : `Current Azure deployment preference: ${current.subscriptionName}.`,
      )
      provider = await select({
        message: 'Which deployment preference should be recorded?',
        choices: [
          {
            name: 'Local World (no Azure subscription required)',
            value: 'local' as const,
          },
          {
            name: 'Run Azure Durable Functions preflight',
            value: 'azure' as const,
          },
        ],
        default: 'local',
      })
    }

    const result = await Effect.runPromise(
      configureWorldSelection(
        provider === 'local'
          ? {provider: 'local'}
          : {
              provider: 'azure',
              ...(flags.subscription ? {subscriptionId: flags.subscription} : {}),
            },
        (subscriptions) =>
          Effect.tryPromise({
            try: () =>
              select({
                message: 'Select an Azure subscription for the Durable Functions deployment',
                choices: subscriptions.map((candidate) => ({
                  name: candidate.name,
                  value: candidate,
                  description: candidate.id,
                })),
              }) as Promise<AzureSubscription>,
            catch: () =>
              new WorldSelectionFailure({
                operation: 'choose-subscription',
                reason: 'prompt-failed',
              }),
          }),
      ).pipe(Effect.provide(layer)),
    )

    if (result.status === 'azure-unavailable') {
      this.log(
        'Azure sign-in succeeded, but no enabled subscriptions are available. Local deployment preference recorded.',
      )
      return
    }
    if (result.status === 'azure-subscription-inaccessible') {
      this.error(
        `Azure subscription ${result.subscriptionId} is not accessible. Local deployment preference recorded.`,
      )
    }
    if (result.selection.provider === 'local') {
      this.log(
        'Local deployment preference recorded. Azure sign-in and a subscription are not required.',
      )
      return
    }
    this.log(
      `Azure deployment preflight passed and was recorded for subscription ${result.selection.subscriptionName}. Set WORKFLOW_TARGET_WORLD=azure on the deployed hosts to activate it.`,
    )
  }
}
