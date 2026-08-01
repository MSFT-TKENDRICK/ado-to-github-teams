import {Context, Effect, Layer} from 'effect'
import type {ApprovalRequest} from '../types/index.js'
import {MigrationProgressReporterTag, type MigrationProgressEvent} from './migration-progress.js'
import {
  TerminalDashboard,
  type MigrationDashboardState,
  type TerminalDashboardOptions,
} from './terminal-dashboard.js'

export type MigrationPresentationOrigin = 'initial' | 'progress' | 'approval'

export interface MigrationPresentationSnapshot {
  readonly sequence: number
  readonly origin: MigrationPresentationOrigin
  readonly state: MigrationDashboardState
}

export interface MigrationPresentationPacing {
  readonly holdAfter: (event: MigrationProgressEvent) => Effect.Effect<void>
}

export interface ApprovalPresentationOptions {
  readonly prompt?: boolean
  readonly afterSuspend?: () => void
}

export class MigrationPresentationPacingTag extends Context.Tag('MigrationPresentationPacing')<
  MigrationPresentationPacingTag,
  MigrationPresentationPacing
>() {}

export const ImmediateMigrationPresentationPacingLayer = Layer.succeed(
  MigrationPresentationPacingTag,
  {
    holdAfter: () => Effect.void,
  },
)

export function sandboxPresentationHoldMs(event: MigrationProgressEvent): number {
  return event.status === 'completed' || event.status === 'failed' ? 650 : 350
}

export function makeSandboxInteractivePresentationPacingLayer(
  sleep: (milliseconds: number) => Effect.Effect<void> = (milliseconds) =>
    Effect.sleep(`${milliseconds} millis`),
) {
  return Layer.succeed(MigrationPresentationPacingTag, {
    holdAfter: (event) => sleep(sandboxPresentationHoldMs(event)),
  })
}

export class TerminalMigrationPresentation {
  private readonly dashboard: TerminalDashboard
  private readonly trace: MigrationPresentationSnapshot[]
  private state: MigrationDashboardState
  private sequence = 0

  public constructor(state: MigrationDashboardState, options: TerminalDashboardOptions = {}) {
    this.state = {...state}
    this.dashboard = new TerminalDashboard(state, options)
    this.trace = [{sequence: this.sequence, origin: 'initial', state: {...state}}]
  }

  public get isInteractive(): boolean {
    return this.dashboard.isEnabled
  }

  public start(): void {
    this.dashboard.start()
  }

  public stop(): void {
    this.dashboard.stop()
  }

  public update(
    update: Partial<MigrationDashboardState> | MigrationProgressEvent,
    origin: MigrationPresentationOrigin = 'progress',
  ): void {
    this.state = {...this.state, ...update}
    this.sequence += 1
    this.trace.push({sequence: this.sequence, origin, state: {...this.state}})
    this.dashboard.update(update)
  }

  public snapshots(): readonly MigrationPresentationSnapshot[] {
    return this.trace.map((snapshot) => ({...snapshot, state: {...snapshot.state}}))
  }

  public withApproval<A, E, R>(
    request: ApprovalRequest,
    decision: Effect.Effect<A, E, R>,
    options: ApprovalPresentationOptions = {},
  ): Effect.Effect<A, E, R> {
    const prompt = options.prompt ?? true
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        if (prompt) {
          this.update(
            {
              status: 'blocked',
              message: `Operator approval required: ${request.action}`,
              nextAction:
                'Respond to the approval prompt to continue or decline this exact change.',
            },
            'approval',
          )
        }
        const suspension = this.dashboard.suspend()
        options.afterSuspend?.()
        return suspension
      }),
      () => decision,
      (suspension) =>
        Effect.sync(() => {
          if (prompt) {
            this.update(
              {
                status: 'running',
                message: 'Approval prompt closed; migration orchestration is continuing.',
                nextAction: undefined,
              },
              'approval',
            )
          }
          this.dashboard.resume(suspension)
        }),
    )
  }
}

export function makeMigrationPresentationProgressLayer(
  presentation: TerminalMigrationPresentation,
  pacingLayer: Layer.Layer<MigrationPresentationPacingTag> = ImmediateMigrationPresentationPacingLayer,
): Layer.Layer<MigrationProgressReporterTag> {
  const progressLayer = Layer.effect(
    MigrationProgressReporterTag,
    Effect.gen(function* () {
      const pacing = yield* MigrationPresentationPacingTag
      return {
        publish: (event: MigrationProgressEvent) =>
          Effect.sync(() => presentation.update(event)).pipe(
            Effect.zipRight(pacing.holdAfter(event)),
          ),
      }
    }),
  )
  return Layer.provide(progressLayer, pacingLayer)
}
