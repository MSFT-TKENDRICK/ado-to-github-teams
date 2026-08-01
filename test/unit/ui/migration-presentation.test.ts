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
import {renderApprovalRequestContext} from '../../../src/ui/approval-context.js'
import type {TerminalOutput} from '../../../src/ui/terminal-dashboard.js'

const runningEvent: MigrationProgressEvent = {
  runId: 'sandbox-happy-path-run',
  phase: 'map',
  status: 'running',
  message: 'Matching source identities to managed GitHub users.',
  updatedAt: '2026-07-31T00:00:00.000Z',
}

class FakeTerminal implements TerminalOutput {
  public isTTY = true
  public columns = 120
  public rows = 30
  public readonly writes: string[] = []

  public write(chunk: string): void {
    this.writes.push(chunk)
  }
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

  it('writes exact approval context after leaving the alternate screen and before re-entering', async () => {
    const output = new FakeTerminal()
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
      {output, env: {TERM: 'xterm-256color'}, reducedMotion: true},
    )
    const request = {
      action: 'Create 1 teams in contoso',
      context: {teamCount: 1, githubOrg: 'contoso'},
      displayLines: ['core: {"name":"Core","privacy":"closed"}'],
      autoApprovable: false,
    }

    presentation.start()
    await Effect.runPromise(
      presentation.withApproval(request, Effect.succeed(true), {
        afterSuspend: () => {
          for (const line of renderApprovalRequestContext(request)) {
            output.write(`${line}\n`)
          }
        },
      }),
    )
    presentation.stop()

    const leaveIndex = output.writes.findIndex((chunk) => chunk.includes('\u001b[?1049l'))
    const contextIndex = output.writes.findIndex((chunk) => chunk.includes('Exact proposed writes'))
    const reenterIndex = output.writes.findIndex(
      (chunk, index) => index > leaveIndex && chunk.includes('\u001b[?1049h'),
    )
    expect(leaveIndex).toBeGreaterThanOrEqual(0)
    expect(contextIndex).toBeGreaterThan(leaveIndex)
    expect(reenterIndex).toBeGreaterThan(contextIndex)
    expect(output.writes.join('')).toContain('Create 1 teams in contoso')
    expect(output.writes.join('')).toContain('core: {"name":"Core","privacy":"closed"}')
  })

  it('suspends interactive output for a predefined decision without claiming input is required', async () => {
    const output = new FakeTerminal()
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
      {output, env: {TERM: 'xterm-256color'}, reducedMotion: true},
    )

    presentation.start()
    await Effect.runPromise(
      presentation.withApproval(
        {
          action: 'Create 1 teams in contoso',
          context: {teamCount: 1},
          displayLines: ['core'],
          autoApprovable: false,
        },
        Effect.succeed(true),
        {
          prompt: false,
          afterSuspend: () => output.write('Using the predefined sandbox decision from --yes.\n'),
        },
      ),
    )
    presentation.stop()

    expect(presentation.snapshots()).toHaveLength(1)
    expect(output.writes.join('')).toContain('Using the predefined sandbox decision from --yes.')
    expect(output.writes.join('')).not.toContain('NEEDS INPUT')
  })
})
