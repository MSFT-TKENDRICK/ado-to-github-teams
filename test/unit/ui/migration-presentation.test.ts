import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  makeMigrationPresentationProgressLayer,
  makeSandboxInteractivePresentationPacingLayer,
  sandboxPresentationHoldMs,
  TerminalMigrationPresentation,
} from '../../../src/ui/migration-presentation.js'
import {
  MigrationProgressReporterTag,
  type MigrationProgressEvent,
} from '../../../src/ui/migration-progress.js'

const runningEvent: MigrationProgressEvent = {
  runId: 'sandbox-happy-path-run',
  phase: 'map',
  status: 'running',
  message: 'Matching source identities to managed GitHub users.',
  updatedAt: '2026-07-31T00:00:00.000Z',
}

describe('terminal migration presentation', () => {
  it('paces executed progress through an injected Effect timing service', async () => {
    const delays: number[] = []
    const presentation = new TerminalMigrationPresentation(
      {
        runId: runningEvent.runId,
        source: 'https://dev.azure.com/contoso/Platform',
        target: 'contoso',
        apply: false,
        phase: 'fetch',
        status: 'running',
        message: 'Preparing deterministic provider boundaries.',
        sandbox: true,
      },
      {enabled: false},
    )
    const pacing = makeSandboxInteractivePresentationPacingLayer((milliseconds) =>
      Effect.sync(() => delays.push(milliseconds)),
    )
    const progress = Effect.gen(function* () {
      const reporter = yield* MigrationProgressReporterTag
      yield* reporter.publish(runningEvent)
      yield* reporter.publish({
        ...runningEvent,
        phase: 'report',
        status: 'completed',
        message: 'Dry-run report is ready for review.',
      })
    })

    await Effect.runPromise(
      progress.pipe(Effect.provide(makeMigrationPresentationProgressLayer(presentation, pacing))),
    )

    expect(delays).toEqual([
      sandboxPresentationHoldMs(runningEvent),
      sandboxPresentationHoldMs({...runningEvent, status: 'completed'}),
    ])
    expect(presentation.snapshots().map(({state}) => `${state.phase}:${state.status}`)).toEqual([
      'fetch:running',
      'map:running',
      'report:completed',
    ])
  })

  it('records a blocked approval state before resuming orchestration', async () => {
    const presentation = new TerminalMigrationPresentation(
      {
        runId: runningEvent.runId,
        source: 'https://dev.azure.com/contoso/Platform',
        target: 'contoso',
        apply: true,
        phase: 'create-teams',
        status: 'running',
        message: 'Creating approved GitHub team structures.',
        sandbox: true,
      },
      {enabled: false},
    )

    const approved = await Effect.runPromise(
      presentation.withApproval(
        {
          action: 'Create 1 teams in contoso',
          context: {teamCount: 1},
          displayLines: ['core'],
          autoApprovable: false,
        },
        Effect.succeed(true),
      ),
    )

    expect(approved).toBe(true)
    expect(
      presentation.snapshots().map(({origin, state}) => ({
        origin,
        status: state.status,
        phase: state.phase,
        nextAction: state.nextAction,
      })),
    ).toEqual([
      {
        origin: 'initial',
        status: 'running',
        phase: 'create-teams',
        nextAction: undefined,
      },
      {
        origin: 'approval',
        status: 'blocked',
        phase: 'create-teams',
        nextAction: 'Respond to the approval prompt to continue or decline this exact change.',
      },
      {
        origin: 'approval',
        status: 'running',
        phase: 'create-teams',
        nextAction: undefined,
      },
    ])
  })
})
