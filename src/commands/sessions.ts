import {randomUUID} from 'node:crypto'
import {Command, Flags} from '@oclif/core'
import {confirm, select} from '@inquirer/prompts'
import chalk from 'chalk'
import {Effect} from 'effect'
import type {
  BlockingElicitation,
  ElicitationAction,
} from '../types/index.js'
import {
  makeWorkflowWorkerLayer,
  type WorkerMigrationStatus,
  WorkflowWorkerServiceTag,
} from '../workflow/client.js'

export interface SessionInboxRow {
  readonly runId: string
  readonly source: string
  readonly target: string
  readonly phase: string
  readonly status: string
  readonly blocked: number
  readonly elicitations: string
  readonly updatedAt: string
}

export function sessionInboxRows(
  sessions: ReadonlyArray<WorkerMigrationStatus>,
  blockedOnly = false,
): SessionInboxRow[] {
  return sessions.flatMap((session) => {
    if (!session.migration) {
      return []
    }
    const blocked = session.migration.elicitations.filter(
      (elicitation) => elicitation.status === 'pending',
    ).length
    if (blockedOnly && blocked === 0) {
      return []
    }
    return [
      {
        runId: session.migration.runId,
        source: `${session.migration.adoOrg}/${session.migration.adoProject}`,
        target: session.migration.githubOrg,
        phase: session.migration.phase,
        status: session.workflowStatus,
        blocked,
        elicitations: session.migration.elicitations
          .filter((elicitation) => elicitation.status === 'pending')
          .map((elicitation) => `${elicitation.id}:${elicitation.kind}`)
          .join(', '),
        updatedAt: session.migration.updatedAt,
      },
    ]
  })
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width)
}

export function renderSessionInbox(rows: readonly SessionInboxRow[]): string {
  if (rows.length === 0) {
    return 'No migration sessions match the requested filter.'
  }
  const widths = {
    runId: Math.max(6, ...rows.map((row) => row.runId.length)),
    source: Math.max(6, ...rows.map((row) => row.source.length)),
    target: Math.max(6, ...rows.map((row) => row.target.length)),
    phase: Math.max(5, ...rows.map((row) => row.phase.length)),
    status: Math.max(6, ...rows.map((row) => row.status.length)),
    elicitations: Math.max(
      12,
      ...rows.map((row) => row.elicitations.length),
    ),
  }
  return [
    `${pad('RUN ID', widths.runId)}  ${pad('SOURCE', widths.source)}  ${pad('TARGET', widths.target)}  ${pad('PHASE', widths.phase)}  ${pad('STATUS', widths.status)}  BLOCKED  ${pad('ELICITATIONS', widths.elicitations)}  UPDATED`,
    ...rows.map(
      (row) =>
        `${pad(row.runId, widths.runId)}  ${pad(row.source, widths.source)}  ${pad(row.target, widths.target)}  ${pad(row.phase, widths.phase)}  ${pad(row.status, widths.status)}  ${pad(row.blocked, 7)}  ${pad(row.elicitations || '-', widths.elicitations)}  ${row.updatedAt}`,
    ),
  ].join('\n')
}

function pendingElicitations(
  session: WorkerMigrationStatus,
): ReadonlyArray<BlockingElicitation> {
  return (
    session.migration?.elicitations.filter(
      (elicitation) => elicitation.status === 'pending',
    ) ?? []
  )
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
      description: 'Print the session inbox as JSON',
      default: false,
    }),
    select: Flags.boolean({
      description: 'Interactively switch between and answer blocked sessions',
      default: false,
    }),
    'worker-url': Flags.string({
      description: 'Durable migration worker URL',
      default: process.env.WORKFLOW_BASE_URL ?? 'http://127.0.0.1:7331',
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
    let sessions = await Effect.runPromise(worker.sessions)
    const rows = sessionInboxRows(sessions, flags.blocked)
    if (flags.json) {
      this.log(JSON.stringify(rows, null, 2))
      return
    }
    this.log(renderSessionInbox(rows))
    if (!flags.select) {
      return
    }

    let keepSelecting = true
    while (keepSelecting) {
      const selectable = sessions.filter(
        (session) => pendingElicitations(session).length > 0,
      )
      if (selectable.length === 0) {
        this.log(chalk.green('No sessions have blocking elicitations.'))
        keepSelecting = false
        continue
      }
      const runId = await select<string>({
        message: 'Switch to a blocked migration session',
        choices: [
          ...selectable.map((session) => ({
            name: `${session.migration?.runId} — ${pendingElicitations(session).length} blocked — ${session.migration?.adoProject} -> ${session.migration?.githubOrg}`,
            value: session.migration?.runId ?? '',
          })),
          {name: 'Exit session inbox', value: ''},
        ],
      })
      if (!runId) {
        keepSelecting = false
        continue
      }
      const session = selectable.find(
        (candidate) => candidate.migration?.runId === runId,
      )
      if (!session?.migration) {
        continue
      }
      const elicitationId = await select<string>({
        message: `Blocking elicitations for ${runId}`,
        choices: pendingElicitations(session).map((elicitation) => ({
          name: `${elicitation.kind}: ${elicitation.summary}`,
          value: elicitation.id,
        })),
      })
      const elicitation = pendingElicitations(session).find(
        (candidate) => candidate.id === elicitationId,
      )
      if (!elicitation) {
        continue
      }
      this.log(chalk.bold(elicitation.summary))
      this.log(elicitation.semanticSummary)
      this.log(`Proposed action: ${elicitation.proposedAction}`)
      this.log(`Trace: ${elicitation.traceId}`)
      if (elicitation.reportPath) {
        this.log(await Effect.runPromise(worker.escalationReport(runId, elicitation.id)))
      }
      const action = await select<ElicitationAction>({
        message: 'Resolve this elicitation',
        choices: elicitation.allowedActions.map((allowed) => ({
          name: allowed,
          value: allowed,
        })),
      })
      if (
        action === 'approve' &&
        session.migration.apply &&
        !(await confirm({
          message:
            'This is a live migration. Apply the exact fingerprinted change shown above?',
          default: false,
        }))
      ) {
        continue
      }
      await Effect.runPromise(
        worker.answerElicitation(runId, {
          elicitationId: elicitation.id,
          expectedFingerprint: elicitation.contextFingerprint,
          answerId: randomUUID(),
          action,
          answeredBy:
            process.env.USER ??
            process.env.USERNAME ??
            'interactive-operator',
        }),
      )
      sessions = await Effect.runPromise(worker.sessions)
      this.log(chalk.green(`Resolved ${elicitation.id}; returning to the session inbox.`))
    }
  }
}
