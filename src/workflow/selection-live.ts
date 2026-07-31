import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {SubscriptionClient} from '@azure/arm-subscriptions'
import {Effect, Either, Layer, Schema} from 'effect'
import {AuthManager} from '../auth/manager.js'
import {
  AzureSubscriptionSchema,
  AzureSubscriptionServiceTag,
  WorldSelectionFailure,
  WorldSelectionSchema,
  WorldSelectionStoreTag,
  type AzureSubscription,
  type WorldSelection,
} from './selection.js'

const defaultSelectionPath = path.join(homedir(), '.ado-github-teams', 'world.json')

function failure(
  operation: WorldSelectionFailure['operation'],
  reason: string,
): WorldSelectionFailure {
  return new WorldSelectionFailure({operation, reason})
}

export interface AzureSubscriptionLayerOptions {
  readonly authenticationManager?: Pick<AuthManager, 'resolveAzureCredential'>
  readonly createClient?: (
    credential: Awaited<ReturnType<AuthManager['resolveAzureCredential']>>,
  ) => AzureSubscriptionClient
}

interface AzureSubscriptionRecord {
  readonly displayName?: string
  readonly state?: string
  readonly subscriptionId?: string
}

export interface AzureSubscriptionClient {
  readonly subscriptions: {
    readonly list: () => AsyncIterable<AzureSubscriptionRecord>
  }
}

export function makeAzureSubscriptionLayer(options: AzureSubscriptionLayerOptions = {}) {
  return Layer.succeed(AzureSubscriptionServiceTag, {
    list: Effect.tryPromise({
      try: async () => {
        const manager = options.authenticationManager ?? new AuthManager()
        const credential = await manager.resolveAzureCredential()
        const client: AzureSubscriptionClient =
          options.createClient?.(credential) ?? new SubscriptionClient(credential)
        const subscriptions: AzureSubscription[] = []
        for await (const subscription of client.subscriptions.list()) {
          if (
            subscription.state === 'Enabled' &&
            subscription.subscriptionId &&
            subscription.displayName
          ) {
            subscriptions.push(
              Schema.decodeUnknownSync(AzureSubscriptionSchema)({
                id: subscription.subscriptionId,
                name: subscription.displayName,
              }),
            )
          }
        }
        return subscriptions
      },
      catch: () => failure('list-subscriptions', 'azure-request-failed'),
    }),
  })
}

export function makeWorldSelectionStoreLayer(selectionPath: string = defaultSelectionPath) {
  return Layer.succeed(WorldSelectionStoreTag, {
    load: Effect.tryPromise({
      try: async () => {
        let content: string
        try {
          content = await readFile(selectionPath, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {provider: 'local'} as const
          }
          throw error
        }
        const parsed = Schema.decodeUnknownEither(WorldSelectionSchema)(
          JSON.parse(content) as unknown,
        )
        if (Either.isLeft(parsed)) {
          throw failure('load-selection', 'schema-mismatch')
        }
        return parsed.right
      },
      catch: (error) =>
        error instanceof WorldSelectionFailure ? error : failure('load-selection', 'read-failed'),
    }),
    save: (selection: WorldSelection) =>
      Effect.tryPromise({
        try: async () => {
          const decoded = Schema.decodeUnknownSync(WorldSelectionSchema)(selection)
          await mkdir(path.dirname(selectionPath), {recursive: true})
          await writeFile(selectionPath, `${JSON.stringify(decoded, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          })
          await chmod(selectionPath, 0o600)
        },
        catch: () => failure('save-selection', 'write-failed'),
      }),
  })
}
