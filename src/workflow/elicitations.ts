import {createHash} from 'node:crypto'
import path from 'node:path'
import type {
  BlockingElicitation,
  CheckpointState,
  ElicitationAction,
} from '../types/index.js'

export interface ElicitationDecision {
  readonly elicitationId: string
  readonly expectedFingerprint: string
  readonly answerId: string
  readonly action: ElicitationAction
  readonly answeredBy: string
  readonly comment?: string
}

export class ElicitationNotFoundError extends Error {}
export class ElicitationStaleError extends Error {}
export class ElicitationConflictError extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[REDACTED JWT]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(token|secret|password|authorization)\s*[:=]\s*["']?[^,\s"']+/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[REDACTED EMAIL]',
    )
}

export function containedPath(
  rootDirectory: string,
  candidatePath: string,
): string | null {
  const root = path.resolve(rootDirectory)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(root, candidate)
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? null
    : candidate
}

function planContext(state: CheckpointState) {
  return {
    runId: state.runId,
    githubOrg: state.githubOrg,
    mode: state.migrationConfig.apply ? 'apply' : 'dry-run',
    teams: (state.teamPlan ?? []).map((planned) => ({
      slug: planned.team.slug,
      name: planned.team.name,
      parentSlug: planned.parentSlug ?? null,
      kind: planned.kind,
    })),
    memberAssignments: state.mappings.flatMap((mapping) =>
      mapping.memberMappings
        .filter((member) => member.mapped && member.githubUser)
        .map(
          (member) =>
            `${mapping.githubTeam.slug}:${member.githubUser?.login ?? ''}`,
        ),
    ),
    repositoryGrants: (state.repositoryGrants ?? []).map((grant) => ({
      teamSlug: grant.teamSlug,
      repository: grant.repository,
      role: grant.role,
      basePermission: grant.basePermission,
      visibility: grant.visibility,
    })),
  }
}

export function registerApplyElicitation(
  state: CheckpointState,
  timestamp: string,
): CheckpointState {
  const applyState = {
    ...state,
    migrationConfig: {...state.migrationConfig, apply: true},
  }
  const context = planContext(applyState)
  const contextFingerprint = fingerprint(context)
  const id = `apply-${state.runId}`
  const existing = (state.elicitations ?? []).find(
    (elicitation) => elicitation.id === id,
  )
  if (existing) {
    if (existing.contextFingerprint !== contextFingerprint) {
      throw new ElicitationConflictError(
        `Apply elicitation ${id} no longer matches the persisted migration plan.`,
      )
    }
    return state
  }

  const traceId = fingerprint({runId: state.runId, id}).slice(0, 32)
  const elicitation: BlockingElicitation = {
    id,
    runId: state.runId,
    kind: 'apply-approval',
    status: 'pending',
    phase: state.phase,
    summary: `Approve the exact migration plan for ${state.githubOrg}`,
    semanticSummary:
      'The migration plan is complete and requires explicit operator approval before provider writes.',
    proposedAction: `Apply ${context.teams.length} team, ${context.memberAssignments.length} member, and ${context.repositoryGrants.length} repository changes.`,
    allowedActions: ['approve', 'reject'],
    contextFingerprint,
    createdAt: timestamp,
    traceId,
    workItems: [
      {
        owner: 'human',
        description:
          'Review the exact team, membership, and repository permission plan before allowing writes.',
        estimatedEffort: '5-15 minutes',
      },
    ],
  }
  return {
    ...state,
    migrationConfig: applyState.migrationConfig,
    timestamp,
    elicitations: [...(state.elicitations ?? []), elicitation],
    traceLogs: [
      ...(state.traceLogs ?? []),
      {
        timestamp,
        level: 'info',
        source: 'workflow',
        traceId,
        message: 'Persisted blocking apply approval elicitation.',
      },
    ],
  }
}

function workItemsForFailure(
  service: string,
  message: string,
): BlockingElicitation['workItems'] {
  const normalized = message.toLowerCase()
  const workItems: Array<BlockingElicitation['workItems'][number]> = [
    {
      owner: 'agent',
      description:
        'Reproduce the failed migration unit with the persisted configuration and inspect the typed provider response.',
      estimatedEffort: '30-60 minutes',
    },
  ]
  if (
    normalized.includes('permission') ||
    normalized.includes('forbidden') ||
    service === 'approval'
  ) {
    workItems.push({
      owner: 'human',
      description:
        'Verify Entra, Azure DevOps, and GitHub organization permissions using least-privilege access.',
      estimatedEffort: '15-30 minutes',
    })
  } else {
    workItems.push({
      owner: 'human',
      description:
        'Confirm the source and target resources still match the migration scope and decide whether to retry, skip, or abort.',
      estimatedEffort: '15-45 minutes',
    })
  }
  return workItems
}

export function registerHealingEscalation(
  state: CheckpointState,
  failure: {readonly tag: string; readonly service: string; readonly message: string},
  timestamp: string,
  reportPath: string,
): {readonly state: CheckpointState; readonly elicitation: BlockingElicitation} {
  const safeFailure = {
    tag: failure.tag,
    service: failure.service,
    message: redactDiagnosticText(failure.message),
  }
  const contextFingerprint = fingerprint({
    runId: state.runId,
    phase: state.phase,
    configurationHash: state.configurationHash,
    failure: safeFailure,
  })
  const id = `escalation-${contextFingerprint.slice(0, 20)}`
  const existing = (state.elicitations ?? []).find(
    (elicitation) => elicitation.id === id,
  )
  if (existing) {
    return {state, elicitation: existing}
  }
  const traceId = fingerprint({runId: state.runId, id}).slice(0, 32)
  const agentSessionId = `agent-${traceId.slice(0, 16)}`
  const threadId = `thread-${traceId.slice(16)}`
  const elicitation: BlockingElicitation = {
    id,
    runId: state.runId,
    kind: 'healing-escalation',
    status: 'pending',
    phase: state.phase,
    summary: `Unresolved ${safeFailure.tag} in ${safeFailure.service}`,
    semanticSummary: `${safeFailure.service} could not complete the ${state.phase} phase: ${safeFailure.message}`,
    proposedAction:
      'Pause this migration session until an operator or repair agent can resolve the failure.',
    allowedActions: ['abort'],
    contextFingerprint,
    createdAt: timestamp,
    traceId,
    agentSessionId,
    threadId,
    failure: safeFailure,
    workItems: workItemsForFailure(safeFailure.service, safeFailure.message),
    reportPath,
  }
  return {
    elicitation,
    state: {
      ...state,
      timestamp,
      elicitations: [...(state.elicitations ?? []), elicitation],
      traceLogs: [
        ...(state.traceLogs ?? []),
        {
          timestamp,
          level: 'error',
          source: 'healing',
          traceId,
          message: safeFailure.message,
        },
      ],
    },
  }
}

export function resolveElicitation(
  state: CheckpointState,
  decision: ElicitationDecision,
  timestamp: string,
): CheckpointState {
  const elicitations = state.elicitations ?? []
  const index = elicitations.findIndex(
    (elicitation) => elicitation.id === decision.elicitationId,
  )
  if (index < 0) {
    throw new ElicitationNotFoundError(
      `Elicitation ${decision.elicitationId} was not found.`,
    )
  }
  const elicitation = elicitations[index]!
  if (elicitation.contextFingerprint !== decision.expectedFingerprint) {
    throw new ElicitationStaleError(
      `Elicitation ${elicitation.id} changed; refresh the session inbox before answering.`,
    )
  }
  if (!elicitation.allowedActions.includes(decision.action)) {
    throw new ElicitationConflictError(
      `Action ${decision.action} is not valid for elicitation ${elicitation.id}.`,
    )
  }
  if (elicitation.answer) {
    const sameAnswer =
      elicitation.answer.answerId === decision.answerId &&
      elicitation.answer.action === decision.action &&
      elicitation.answer.answeredBy === decision.answeredBy &&
      elicitation.answer.comment === decision.comment
    if (sameAnswer) {
      return state
    }
    throw new ElicitationConflictError(
      `Elicitation ${elicitation.id} already has an immutable answer.`,
    )
  }
  if (elicitation.status !== 'pending') {
    throw new ElicitationConflictError(
      `Elicitation ${elicitation.id} is ${elicitation.status}.`,
    )
  }

  const resolved: BlockingElicitation = {
    ...elicitation,
    status: 'resolved',
    answer: {
      answerId: decision.answerId,
      action: decision.action,
      answeredBy: decision.answeredBy,
      answeredAt: timestamp,
      ...(decision.comment === undefined ? {} : {comment: decision.comment}),
    },
  }
  const next = [...elicitations]
  next[index] = resolved
  return {
    ...state,
    timestamp,
    elicitations: next,
    traceLogs: [
      ...(state.traceLogs ?? []),
      {
        timestamp,
        level: 'info',
        source: 'workflow',
        traceId: elicitation.traceId,
        message: `Elicitation resolved with action ${decision.action}.`,
      },
    ],
  }
}

function markdownList(values: readonly string[], empty: string): string {
  return values.length === 0
    ? `- ${empty}`
    : values.map((value) => `- ${redactDiagnosticText(value)}`).join('\n')
}

export function renderEscalationReport(
  state: CheckpointState,
  elicitation: BlockingElicitation,
): string {
  const actor = state.entraActor
  const trace = state.traceContext
  const conversations = (state.agentConversationHistory ?? []).map(
    (entry) =>
      `${entry.timestamp} ${entry.agentSessionId}/${entry.threadId} ${entry.role}: ${redactDiagnosticText(entry.content)}`,
  )
  const logs = (state.traceLogs ?? []).map(
    (entry) =>
      `${entry.timestamp} [${entry.level}] ${entry.source}/${entry.traceId}: ${redactDiagnosticText(entry.message)}`,
  )
  const failures = state.failureLog.map(
    (entry) =>
      `${entry.failureMode}: ${redactDiagnosticText(entry.error)}; healing=${redactDiagnosticText(entry.healingAction)}; resolved=${entry.resolved}`,
  )
  const approvals = state.approvalHistory.map(
    (entry) =>
      `${entry.timestamp} ${entry.action}: ${entry.approved ? 'approved' : 'rejected'}`,
  )
  return [
    '# Migration Escalation Report',
    '',
    `- **Elicitation ID:** ${elicitation.id}`,
    `- **Migration session:** ${state.runId}`,
    `- **Phase:** ${state.phase}`,
    `- **Created:** ${elicitation.createdAt}`,
    `- **Context fingerprint:** ${elicitation.contextFingerprint}`,
    '',
    '## Semantic Error Summary',
    '',
    redactDiagnosticText(elicitation.semanticSummary),
    '',
    '## Estimated Resolution Work',
    '',
    ...elicitation.workItems.map(
      (item) =>
        `- **${item.owner}:** ${item.description} (estimated ${item.estimatedEffort})`,
    ),
    '',
    '## Entra Migration Actor',
    '',
    `- **Kind:** ${actor?.kind ?? 'unknown'}`,
    `- **Description:** ${redactDiagnosticText(actor?.displayName ?? 'Entra actor metadata was unavailable')}`,
    `- **Tenant:** ${actor?.tenantId ?? 'not recorded'}`,
    `- **Client:** ${actor?.clientId ?? 'not recorded'}`,
    '',
    '## Trace Identifiers',
    '',
    `- **Agent session:** ${elicitation.agentSessionId ?? 'not created'}`,
    `- **Agent thread:** ${elicitation.threadId ?? 'not created'}`,
    `- **Failure trace:** ${elicitation.traceId}`,
    `- **Workflow run:** ${trace?.workflowRunId ?? 'not recorded'}`,
    `- **Durable workload trace:** ${trace?.durableWorkloadTraceId ?? 'not recorded'}`,
    '',
    '## Source and Target Configuration',
    '',
    `- **Azure DevOps organization:** ${state.adoOrg}`,
    `- **Azure DevOps project:** ${state.adoProject}`,
    `- **GitHub organization:** ${state.githubOrg}`,
    `- **Mode:** ${state.migrationConfig.apply ? 'apply' : 'dry-run'}`,
    `- **Concurrency:** ${state.migrationConfig.concurrency ?? 1}`,
    `- **Prefix:** ${state.migrationConfig.prefix || 'none'}`,
    `- **Suffix:** ${state.migrationConfig.suffix || 'none'}`,
    `- **Topology digest:** ${state.migrationConfig.topologyDigest || 'none'}`,
    '',
    '## Failure Details',
    '',
    `- **Type:** ${elicitation.failure?.tag ?? 'unknown'}`,
    `- **Service:** ${elicitation.failure?.service ?? 'unknown'}`,
    `- **Message:** ${redactDiagnosticText(elicitation.failure?.message ?? 'No message recorded')}`,
    '',
    '## Trace Logs',
    '',
    markdownList(logs, 'No trace logs were captured.'),
    '',
    '## Failure History',
    '',
    markdownList(failures, 'No earlier failures were recorded.'),
    '',
    '## Agent and Subagent Conversation History',
    '',
    markdownList(
      conversations,
      'No agent conversation was captured before escalation.',
    ),
    '',
    '## Approval History',
    '',
    markdownList(approvals, 'No approvals were recorded.'),
    '',
    '## Durable State Context',
    '',
    `- **Configuration hash:** ${state.configurationHash}`,
    `- **Completed teams:** ${state.completedTeams.length}`,
    `- **Completed member assignments:** ${state.completedMemberPairs.length}`,
    `- **Completed repository grants:** ${(state.completedRepositoryGrants ?? []).length}`,
    `- **Pending elicitations:** ${(state.elicitations ?? []).filter((item) => item.status === 'pending').length}`,
    '',
  ].join('\n')
}
