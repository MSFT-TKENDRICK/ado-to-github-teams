import {Context, Effect, Layer, Option} from 'effect'

export type MigrationProgressStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed'

export interface MigrationProgressEvent {
  readonly runId: string
  readonly phase: string
  readonly status: MigrationProgressStatus
  readonly message: string
  readonly updatedAt: string
  readonly completedUnits?: number
  readonly totalUnits?: number
  readonly unitLabel?: string
}

export interface MigrationProgressReporter {
  readonly publish: (event: MigrationProgressEvent) => Effect.Effect<void>
}

export class MigrationProgressReporterTag extends Context.Tag('MigrationProgressReporter')<
  MigrationProgressReporterTag,
  MigrationProgressReporter
>() {}

export function makeMigrationProgressLayer(
  publish: (event: MigrationProgressEvent) => void,
): Layer.Layer<MigrationProgressReporterTag> {
  return Layer.succeed(MigrationProgressReporterTag, {
    publish: (event) => Effect.sync(() => publish(event)),
  })
}

export function publishMigrationProgress(
  event: MigrationProgressEvent,
): Effect.Effect<void, never, never> {
  return Effect.serviceOption(MigrationProgressReporterTag).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (reporter) => reporter.publish(event),
      }),
    ),
  )
}
