import {select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import {Effect, Layer} from 'effect'
import {
  configureWorldSelection,
  type AzureSubscription,
  WorldSelectionFailure,
} from '../workflow/selection.js'
import {
  makeAzureSubscriptionLayer,
  makeWorldSelectionStoreLayer,
} from '../workflow/selection-live.js'

export default class World extends Command {
  static override description =
    'Choose local Workflow execution or opt into Azure Durable Functions'

  static override flags = {
    local: Flags.boolean({
      description: 'Select the local World without signing into Azure',
      default: false,
      exclusive: ['subscription'],
    }),
    subscription: Flags.string({
      description: 'Select an accessible Azure subscription by ID',
      required: false,
      exclusive: ['local'],
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(World)
    const provider =
      flags.local || flags.subscription
        ? flags.local
          ? 'local'
          : 'azure'
        : await select({
            message: 'Where should durable workflows run?',
            choices: [
              {
                name: 'Local World (no Azure subscription required)',
                value: 'local' as const,
              },
              {
                name: 'Azure Durable Functions',
                value: 'azure' as const,
              },
            ],
            default: 'local',
          })
    const layer = Layer.merge(makeAzureSubscriptionLayer(), makeWorldSelectionStoreLayer())

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
        'Azure sign-in succeeded, but no enabled subscriptions are available. Local World remains selected.',
      )
      return
    }
    if (result.status === 'azure-subscription-inaccessible') {
      this.error(
        `Azure subscription ${result.subscriptionId} is not accessible. Local World selected.`,
      )
    }
    if (result.selection.provider === 'local') {
      this.log('Local World selected. Azure sign-in and a subscription are not required.')
      return
    }
    this.log(
      `Azure Durable Functions selected for subscription ${result.selection.subscriptionName}.`,
    )
  }
}
