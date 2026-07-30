import {Command, Flags} from '@oclif/core'
import {Effect} from 'effect'
import {runSessionInbox} from '../ui/session-inbox.js'
import {migrationStageStatus} from '../ui/migration-stage-status.js'
import {
  decodePresentationMode,
  DEFAULT_PRESENTATION_MODE,
  type PresentationMode,
} from '../ui/adaptive-detail.js'
import {makeWorkflowWorkerLayer, WorkflowWorkerServiceTag} from '../workflow/client.js'
import type {MigrationSessionSummary} from '../workflow/elicitations.js'

export interface SessionInboxRow {
  readonly runId: string
  readonly source: string
  readonly target: string
  readonly phase: string
  readonly status: string
  readonly currentStage: string
  readonly nextEvent: string
  readonly blocked: number
  readonly elicitations: string
  readonly updatedAt: string
}

export function sessionInboxRows(
  sessions: readonly MigrationSessionSummary[],
  blockedOnly = false,
): SessionInboxRow[] {
  return sessions
    .filter((session) => !blockedOnly || session.blockingElicitations.length > 0)
    .map((session) => {
      const stage = migrationStageStatus({
        runId: session.runId,
        phase: session.phase,
        workflowStatus: session.workflowStatus,
        updatedAt: session.updatedAt,
        blockingCount: session.blockingElicitations.length,
      })
      return {
        runId: session.runId,
        source: `${session.adoOrg}/${session.adoProject}`,
        target: session.githubOrg,
        phase: session.phase,
        status: stage.state,
        currentStage: stage.currentStage,
        nextEvent: stage.nextEvent,
        blocked: session.blockingElicitations.length,
        elicitations: session.blockingElicitations
          .map((elicitation) => `${elicitation.id}:${elicitation.kind}`)
          .join(', '),
        updatedAt: stage.lastUpdated,
      }
    })
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width)
}

export function renderSessionInbox(
  rows: readonly SessionInboxRow[],
  presentationMode: PresentationMode = DEFAULT_PRESENTATION_MODE,
): string {
  if (rows.length === 0) {
    return 'No migration sessions match the requested filter.'
  }
  if (presentationMode === 'guided') {
    return rows
      .flatMap((row) => [
        `Run ${row.runId}`,
        `  Source: ${row.source}`,
        `  Target: ${row.target}`,
        `  Status: ${row.status}`,
        `  Current stage: ${row.currentStage}`,
        `  Next event: ${row.nextEvent}`,
        `  Blocking decisions: ${row.blocked}`,
        `  Elicitations: ${row.elicitations || 'none'}`,
        `  Last update: ${row.updatedAt}`,
        '',
      ])
      .slice(0, -1)
      .join('\n')
  }
  const widths = {
    runId: Math.max(6, ...rows.map((row) => row.runId.length)),
    source: Math.max(6, ...rows.map((row) => row.source.length)),
    target: Math.max(6, ...rows.map((row) => row.target.length)),
    currentStage: Math.max(13, ...rows.map((row) => row.currentStage.length)),
    status: Math.max(6, ...rows.map((row) => row.status.length)),
    nextEvent: Math.max(10, ...rows.map((row) => row.nextEvent.length)),
    elicitations: Math.max(12, ...rows.map((row) => row.elicitations.length)),
  }
  return [
    `${pad('RUN ID', widths.runId)}  ${pad('SOURCE', widths.source)}  ${pad('TARGET', widths.target)}  ${pad('STATUS', widths.status)}  ${pad('CURRENT STAGE', widths.currentStage)}  ${pad('NEXT EVENT', widths.nextEvent)}  BLOCKED  ${pad('ELICITATIONS', widths.elicitations)}  UPDATED`,
    ...rows.map(
      (row) =>
        `${pad(row.runId, widths.runId)}  ${pad(row.source, widths.source)}  ${pad(row.target, widths.target)}  ${pad(row.status, widths.status)}  ${pad(row.currentStage, widths.currentStage)}  ${pad(row.nextEvent, widths.nextEvent)}  ${pad(row.blocked, 7)}  ${pad(row.elicitations || '-', widths.elicitations)}  ${row.updatedAt}`,
    ),
  ].join('\n')
}

export default class Sessions extends Command {
  static override description =
    'List and switch between durable migration sessions and blocking elicitations'

  static override flags = {
    blocked: Flags.boolean({
      description: 'Show only sessions with blocking elicitations',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Emit the session inbox as JSON',
      default: false,
    }),
    select: Flags.boolean({
      description: 'Interactively switch between and answer blocked sessions',
      default: false,
    }),
    detail: Flags.string({
      description: 'Presentation detail: guided orientation or compact scanning',
      options: ['guided', 'compact'],
      default: DEFAULT_PRESENTATION_MODE,
    }),
    'worker-url': Flags.string({
      description: 'Workflow worker base URL',
      default: 'http://127.0.0.1:7331',
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Sessions)
    const apiToken = process.env.WORKFLOW_API_TOKEN
    if (!apiToken || apiToken.length < 32) {
      throw new Error('WORKFLOW_API_TOKEN must contain at least 32 characters.')
    }
    const layer = makeWorkflowWorkerLayer(flags['worker-url'], apiToken)
    const worker = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* WorkflowWorkerServiceTag
      }).pipe(Effect.provide(layer)),
    )
    const sessions = await Effect.runPromise(worker.list(flags.blocked, 100))
    const rows = sessionInboxRows(sessions)
    const presentationMode = decodePresentationMode(flags.detail)
    if (flags.json) {
      this.log(JSON.stringify(rows, null, 2))
      return
    }
    this.log(renderSessionInbox(rows, presentationMode))
    if (!flags.select) {
      return
    }
    await runSessionInbox({
      worker,
      log: (message) => this.log(message),
      operator: process.env.USER ?? process.env.USERNAME ?? 'interactive-operator',
    })
  }
}
