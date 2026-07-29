import {select} from '@inquirer/prompts'
import {Effect} from 'effect'
import type {ElicitationResolution} from '../types/index.js'
import type {WorkflowWorkerService} from '../workflow/client.js'
import type {ElicitationRecord, MigrationSessionSummary} from '../workflow/elicitations.js'

export interface InboxChoice {
  readonly name: string
  readonly value: string
  readonly description?: string
}

export type InboxChooser = (message: string, choices: readonly InboxChoice[]) => Promise<string>

export interface SessionInboxDependencies {
  readonly worker: Pick<WorkflowWorkerService, 'list' | 'resolveElicitation'>
  readonly choose?: InboxChooser
  readonly log: (message: string) => void
  readonly operator: string
}

const EXIT = '__exit__'
const REFRESH = '__refresh__'
const SWITCH = '__switch__'

function isResolution(value: string): value is ElicitationResolution {
  return value === 'retry' || value === 'skip' || value === 'abort'
}

export function formatSessionChoice(session: MigrationSessionSummary): string {
  const blocking = session.blockingElicitations.length
  const marker = blocking > 0 ? `[BLOCKED ${blocking}]` : `[${session.workflowStatus}]`
  return `${marker} ${session.runId} · ${session.adoProject} → ${session.githubOrg} · ${session.phase}`
}

export function formatElicitation(elicitation: ElicitationRecord): string[] {
  return [
    `Elicitation ${elicitation.id}`,
    elicitation.summary,
    `Question: ${elicitation.question}`,
    `Durable trace: ${elicitation.workflowRunId} / ${elicitation.hookToken}`,
  ]
}

const liveChooser: InboxChooser = (message, choices) => select({message, choices: [...choices]})

function resolutionChoices(elicitation: ElicitationRecord): readonly InboxChoice[] {
  return [
    ...elicitation.choices.map((action) => ({
      name:
        action === 'abort'
          ? 'Abort and generate an escalation dossier'
          : `${action[0]?.toUpperCase() ?? ''}${action.slice(1)} this migration unit`,
      value: action,
    })),
    {name: 'Switch to another session', value: SWITCH},
    {name: 'Exit session inbox', value: EXIT},
  ]
}

export async function runSessionInbox(dependencies: SessionInboxDependencies): Promise<void> {
  const choose = dependencies.choose ?? liveChooser
  for (;;) {
    const sessions = await Effect.runPromise(dependencies.worker.list(false, 100))
    if (sessions.length === 0) {
      dependencies.log('No durable migration sessions were found.')
      return
    }
    const selectedRunId = await choose('Select a migration session', [
      ...sessions.map((session) => ({
        name: formatSessionChoice(session),
        value: session.runId,
      })),
      {name: 'Refresh sessions', value: REFRESH},
      {name: 'Exit session inbox', value: EXIT},
    ])
    if (selectedRunId === EXIT) {
      return
    }
    if (selectedRunId === REFRESH) {
      continue
    }
    const session = sessions.find((candidate) => candidate.runId === selectedRunId)
    if (!session) {
      throw new Error(`Selected migration session ${selectedRunId} disappeared.`)
    }
    if (session.blockingElicitations.length === 0) {
      dependencies.log(
        `${session.runId} is ${session.workflowStatus} in phase ${session.phase}; it has no blocking elicitations.`,
      )
      continue
    }
    const elicitationId =
      session.blockingElicitations.length === 1
        ? session.blockingElicitations[0]!.id
        : await choose(
            `Select an elicitation for ${session.runId}`,
            session.blockingElicitations.map((elicitation) => ({
              name: `${elicitation.summary} (${elicitation.id})`,
              value: elicitation.id,
            })),
          )
    const elicitation = session.blockingElicitations.find(
      (candidate) => candidate.id === elicitationId,
    )
    if (!elicitation) {
      throw new Error(`Selected elicitation ${elicitationId} disappeared.`)
    }
    for (const line of formatElicitation(elicitation)) {
      dependencies.log(line)
    }
    const action = await choose('Resolve this blocking elicitation', resolutionChoices(elicitation))
    if (action === EXIT) {
      return
    }
    if (action === SWITCH) {
      continue
    }
    if (!isResolution(action) || !elicitation.choices.includes(action)) {
      throw new Error(`Invalid elicitation action: ${action}`)
    }
    await Effect.runPromise(
      dependencies.worker.resolveElicitation(session.runId, elicitation.id, {
        action,
        decidedBy: dependencies.operator,
      }),
    )
    dependencies.log(`Resolved ${elicitation.id} with ${action}; refreshing parallel sessions.`)
  }
}
