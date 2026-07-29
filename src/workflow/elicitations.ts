import {createHash} from 'node:crypto'
import type {AgentTraceContext, ApprovalRequest, ElicitationResolution} from '../types/index.js'
import {maskUserPrincipalName, redactSensitiveText} from '../utils/redaction.js'

export type ElicitationStatus = 'pending' | 'resolved'

export interface EntraOperatorDescription {
  readonly principalType: 'user' | 'service-principal' | 'managed-identity' | 'unknown'
  readonly displayName?: string | undefined
  readonly userPrincipalName?: string | undefined
  readonly tenantId?: string | undefined
  readonly objectId?: string | undefined
  readonly clientId?: string | undefined
}

export interface ElicitationDecision {
  readonly action: ElicitationResolution
  readonly decidedBy: string
  readonly comment?: string | undefined
}

export interface ElicitationRecord {
  readonly id: string
  readonly runId: string
  readonly workflowRunId: string
  readonly hookToken: string
  readonly phase: string
  readonly kind: 'healing' | 'sso'
  readonly status: ElicitationStatus
  readonly summary: string
  readonly question: string
  readonly choices: readonly ElicitationResolution[]
  readonly operation: string
  readonly target: string
  readonly targetType: 'team' | 'member'
  readonly failureMode: string
  readonly actionOnApprove: Exclude<ElicitationResolution, 'abort'>
  readonly createdAt: string
  readonly updatedAt: string
  readonly decision?: ElicitationDecision | undefined
  readonly resumedAt?: string | undefined
  readonly trace?: AgentTraceContext | undefined
  readonly operator: EntraOperatorDescription
  readonly source: {
    readonly adoOrg: string
    readonly adoProject: string
  }
  readonly targetConfiguration: {
    readonly githubOrg: string
    readonly apply: boolean
    readonly concurrency: number
    readonly prefix: string
    readonly suffix: string
  }
}

export interface ElicitationDraft {
  readonly runId: string
  readonly workflowRunId: string
  readonly phase: string
  readonly occurrence: number
  readonly request: ApprovalRequest
  readonly operator: EntraOperatorDescription
  readonly source: ElicitationRecord['source']
  readonly targetConfiguration: ElicitationRecord['targetConfiguration']
  readonly createdAt: string
}

export interface MigrationSessionSummary {
  readonly runId: string
  readonly workflowRunId: string
  readonly workflowStatus: string
  readonly phase: string
  readonly updatedAt: string
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly blockingElicitations: readonly ElicitationRecord[]
  readonly reportKind?: 'migration' | 'escalation' | undefined
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  )
}

export function elicitationIdentity(draft: ElicitationDraft): {
  readonly id: string
  readonly hookToken: string
} {
  if (!draft.request.elicitation) {
    throw new Error('Blocking approval requests require elicitation metadata.')
  }
  const metadata = draft.request.elicitation
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        stableValue({
          runId: draft.runId,
          workflowRunId: draft.workflowRunId,
          phase: draft.phase,
          occurrence: draft.occurrence,
          elicitation: {
            kind: metadata.kind,
            operation: metadata.operation,
            target: metadata.target,
            targetType: metadata.targetType,
            failureMode: metadata.failureMode,
            actionOnApprove: metadata.actionOnApprove,
          },
        }),
      ),
    )
    .digest('hex')
  const id = `elicit-${digest.slice(0, 32)}`
  return {id, hookToken: `migration-elicitation:${id}`}
}

export function toElicitationRecord(draft: ElicitationDraft): ElicitationRecord {
  const metadata = draft.request.elicitation
  if (!metadata) {
    throw new Error('Blocking approval requests require elicitation metadata.')
  }
  const identity = elicitationIdentity(draft)
  return {
    ...identity,
    runId: draft.runId,
    workflowRunId: draft.workflowRunId,
    phase: draft.phase,
    kind: metadata.kind,
    status: 'pending',
    summary: `${metadata.failureMode} while attempting ${metadata.operation} for ${metadata.target}`,
    question: draft.request.action,
    choices: [metadata.actionOnApprove, 'abort'],
    operation: metadata.operation,
    target: metadata.target,
    targetType: metadata.targetType,
    failureMode: metadata.failureMode,
    actionOnApprove: metadata.actionOnApprove,
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
    ...(metadata.trace
      ? {
          trace: {
            ...metadata.trace,
            conversationHistory: metadata.trace.conversationHistory.map((message) => ({
              ...message,
              content: redactSensitiveText(message.content),
            })),
          },
        }
      : {}),
    operator: {
      ...draft.operator,
      ...(draft.operator.userPrincipalName
        ? {
            userPrincipalName: maskUserPrincipalName(draft.operator.userPrincipalName),
          }
        : {}),
    },
    source: draft.source,
    targetConfiguration: draft.targetConfiguration,
  }
}
