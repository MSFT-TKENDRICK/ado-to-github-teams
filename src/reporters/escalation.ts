import type {CheckpointState, FailureLogEntry} from '../types/index.js'
import {
  maskGuid,
  maskOrganizationIdentifier,
  maskUserPrincipalName,
  redactSensitiveText,
} from '../utils/redaction.js'
import type {ElicitationRecord} from '../workflow/elicitations.js'

export interface EscalationReportInput {
  readonly checkpoint: CheckpointState
  readonly elicitation: ElicitationRecord
  readonly generatedAt: string
}

function cell(value: string): string {
  return redactSensitiveText(value)
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ')
}

function failureSummary(entries: readonly FailureLogEntry[]): string {
  if (entries.length === 0) {
    return 'No checkpoint failure entries were recorded before the escalation.'
  }
  const grouped = new Map<string, number>()
  for (const entry of entries) {
    grouped.set(entry.failureMode, (grouped.get(entry.failureMode) ?? 0) + 1)
  }
  return [...grouped.entries()]
    .map(([mode, count]) => `${count} ${mode} failure${count === 1 ? '' : 's'}`)
    .join(', ')
}

function estimatedWork(elicitation: ElicitationRecord): string[] {
  return [
    `Agent: reproduce and classify ${elicitation.failureMode} for ${elicitation.operation} using the trace identifiers below. Only SDK-sourced identifiers are durable and resumable; local correlation IDs are not tracked by GitHub and cannot be looked up externally.`,
    `Human operator: verify whether ${elicitation.target} may be safely ${elicitation.actionOnApprove === 'retry' ? 'retried' : 'skipped'} and document the business impact.`,
    'Service owner: correct the source identity, target authorization, throttling, or provider-state issue identified by the trace logs.',
    'Migration operator: resume from the validated checkpoint and confirm the affected unit is not duplicated.',
  ]
}

export class EscalationReporter {
  public render(input: EscalationReportInput): string {
    const {checkpoint, elicitation} = input
    const trace = elicitation.trace
    const conversation =
      trace?.conversationHistory
        .map(
          (message, index) =>
            `### ${index + 1}. ${message.role}\n\n\`\`\`text\n${redactSensitiveText(message.content)}\n\`\`\``,
        )
        .join('\n\n') ?? '_No agent conversation was captured._'
    const failures =
      checkpoint.failureLog.length === 0
        ? '_No failure log entries were captured._'
        : [
            '| Failure mode | Target | Error | Healing action | Resolved |',
            '| --- | --- | --- | --- | --- |',
            ...checkpoint.failureLog.map(
              (entry) =>
                `| ${cell(entry.failureMode)} | ${cell(entry.target ?? '')} | ${cell(entry.error)} | ${cell(entry.healingAction)} | ${entry.resolved} |`,
            ),
          ].join('\n')

    return [
      '# Unresolved Migration Escalation',
      '',
      '> [!WARNING]',
      '> This dossier contains operational and identity context. Store it according to your organization retention policy.',
      '',
      '## Semantic Error Summary',
      '',
      `${failureSummary(checkpoint.failureLog)}. The blocking elicitation is: ${cell(elicitation.summary)}.`,
      '',
      '## Estimated Resolution Work',
      '',
      ...estimatedWork(elicitation).map((work) => `- ${work}`),
      '',
      '## Entra Migration Principal',
      '',
      `- **Principal type:** ${elicitation.operator.principalType}`,
      `- **Display name:** ${cell(elicitation.operator.displayName ?? 'Unavailable')}`,
      `- **User principal name:** ${maskUserPrincipalName(elicitation.operator.userPrincipalName) ?? 'Unavailable'}`,
      `- **Tenant ID:** ${cell(maskGuid(elicitation.operator.tenantId) ?? 'Unavailable')}`,
      `- **Object ID:** ${cell(maskGuid(elicitation.operator.objectId) ?? 'Unavailable')}`,
      `- **Client ID:** ${cell(maskGuid(elicitation.operator.clientId) ?? 'Unavailable')}`,
      '',
      '## Trace Identifiers',
      '',
      `- **Migration run:** ${checkpoint.runId}`,
      `- **Workflow run:** ${elicitation.workflowRunId}`,
      `- **Elicitation:** ${elicitation.id}`,
      `- **Workflow hook:** ${elicitation.hookToken}`,
      `- **Agent session ID:** ${trace ? cell(trace.agentSessionId) : 'Unavailable'}`,
      `- **Agent session source:** ${trace ? (trace.sdkProvided ? 'GitHub Copilot SDK — durable, resumable via the Copilot SDK/CLI' : 'Local correlation ID only — NOT tracked by GitHub and cannot be looked up externally') : 'Unavailable'}`,
      `- **Agent message ID:** ${trace?.agentMessageId ? cell(trace.agentMessageId) : 'Unavailable'}`,
      `- **Local correlation ID:** ${trace ? cell(trace.localCorrelationId) : 'Unavailable'}`,
      '',
      '## Configured Source and Target',
      '',
      `- **ADO organization:** ${cell(maskOrganizationIdentifier(elicitation.source.adoOrg))}`,
      `- **ADO project:** ${cell(maskOrganizationIdentifier(elicitation.source.adoProject))}`,
      `- **GitHub organization:** ${cell(maskOrganizationIdentifier(elicitation.targetConfiguration.githubOrg))}`,
      `- **Apply mode:** ${elicitation.targetConfiguration.apply}`,
      `- **Concurrency:** ${elicitation.targetConfiguration.concurrency}`,
      `- **Team prefix:** ${cell(maskOrganizationIdentifier(elicitation.targetConfiguration.prefix))}`,
      `- **Team suffix:** ${cell(maskOrganizationIdentifier(elicitation.targetConfiguration.suffix))}`,
      '',
      '## Trace Log',
      '',
      failures,
      '',
      '## Agent and Subagent Conversation History',
      '',
      conversation,
      '',
      '## Elicitation Decision',
      '',
      `- **Status:** ${elicitation.status}`,
      `- **Requested action:** ${elicitation.question}`,
      `- **Allowed choices:** ${elicitation.choices.join(', ')}`,
      `- **Decision:** ${elicitation.decision?.action ?? 'Unresolved'}`,
      `- **Decision maker:** ${cell(elicitation.decision?.decidedBy ?? 'Unavailable')}`,
      `- **Comment:** ${cell(elicitation.decision?.comment ?? '')}`,
      `- **Generated at:** ${input.generatedAt}`,
      '',
    ].join('\n')
  }
}

export {redactSensitiveText as redactEscalationContent}
