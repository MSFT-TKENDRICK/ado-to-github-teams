import {describe, expect, it} from 'vitest'
import {EscalationReporter} from '../../../src/reporters/escalation.js'
import {CHECKPOINT_SCHEMA_VERSION, type CheckpointState} from '../../../src/types/index.js'
import type {ElicitationRecord} from '../../../src/workflow/elicitations.js'

describe('EscalationReporter', () => {
  it('renders required operational context and redacts credentials and direct UPNs', () => {
    const checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      configurationHash: 'hash',
      runId: 'run-1',
      timestamp: '2026-07-29T12:00:00.000Z',
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      migrationConfig: {apply: true, prefix: '', suffix: '', concurrency: 4},
      phase: 'create-teams',
      completedTeams: [],
      completedMemberPairs: [],
      pendingTeams: [],
      mappings: [],
      edgeCases: [],
      skippedItems: [],
      failureLog: [
        {
          failureMode: 'PermissionFailure',
          error: 'authorization=super-secret-value',
          healingAction: 'Escalated with token=another-secret',
          target: 'core',
          resolved: false,
        },
      ],
      approvalHistory: [],
    } satisfies CheckpointState
    const elicitation = {
      id: 'elicit-1',
      runId: 'run-1',
      workflowRunId: 'workflow-1',
      hookToken: 'migration-elicitation:elicit-1',
      phase: 'create-teams',
      kind: 'healing',
      status: 'resolved',
      summary: 'PermissionFailure while attempting create-team for core',
      question: 'Skip failed create-team?',
      choices: ['skip', 'abort'],
      operation: 'create-team',
      target: 'core',
      targetType: 'team',
      failureMode: 'PermissionFailure',
      actionOnApprove: 'skip',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:01:00.000Z',
      decision: {action: 'abort', decidedBy: 'operator'},
      trace: {
        agentSessionId: 'sdk-session-escalation',
        sdkProvided: true,
        agentMessageId: 'sdk-message-escalation',
        localCorrelationId: 'local-correlation-escalation',
        conversationHistory: [
          {
            role: 'user',
            content: 'Bearer fake-token-value authorization=conversation-secret',
          },
        ],
      },
      operator: {
        principalType: 'user',
        userPrincipalName: 'operator@contoso.com',
        tenantId: '11111111-2222-4333-8444-555555555555',
        objectId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        clientId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      },
      source: {
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
      },
      targetConfiguration: {
        githubOrg: 'contoso',
        apply: true,
        concurrency: 4,
        prefix: '',
        suffix: '',
      },
    } satisfies ElicitationRecord

    const markdown = new EscalationReporter().render({
      checkpoint,
      elicitation,
      generatedAt: '2026-07-29T12:02:00.000Z',
    })

    expect(markdown).toContain('## Semantic Error Summary')
    expect(markdown).toContain('## Estimated Resolution Work')
    expect(markdown).toContain('## Entra Migration Principal')
    expect(markdown).toContain('## Trace Identifiers')
    expect(markdown).toContain('## Configured Source and Target')
    expect(markdown).toContain('## Agent and Subagent Conversation History')
    expect(markdown).toContain('o***@contoso.com')
    expect(markdown).toContain('[REDACTED]')
    expect(markdown).not.toContain('super-secret-value')
    expect(markdown).not.toContain('conversation-secret')
    expect(markdown).not.toContain('operator@contoso.com')
    // Tenant/object/client GUIDs are masked by default (only the first 8 hex chars survive).
    expect(markdown).toContain('11111111-****-****-****-************')
    expect(markdown).toContain('66666666-****-****-****-************')
    expect(markdown).toContain('bbbbbbbb-****-****-****-************')
    expect(markdown).not.toContain('11111111-2222-4333-8444-555555555555')
    expect(markdown).not.toContain('66666666-7777-4888-8999-aaaaaaaaaaaa')
    expect(markdown).not.toContain('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')
    // Organization/project identifiers are masked (URL scheme/host preserved, slug masked).
    expect(markdown).toContain('https://dev.azure.com/c*****o')
    expect(markdown).toContain('P******m')
    expect(markdown).not.toContain('https://dev.azure.com/contoso')
    // Trace identifiers are labeled honestly: SDK-provided vs. local-only.
    expect(markdown).toContain('sdk-session-escalation')
    expect(markdown).toContain('sdk-message-escalation')
    expect(markdown).toContain('local-correlation-escalation')
    expect(markdown).toContain('GitHub Copilot SDK — durable, resumable via the Copilot SDK/CLI')
  })

  it('honestly labels a local-only trace as not tracked by GitHub', () => {
    const checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      configurationHash: 'hash',
      runId: 'run-1',
      timestamp: '2026-07-29T12:00:00.000Z',
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      migrationConfig: {apply: true, prefix: '', suffix: '', concurrency: 4},
      phase: 'create-teams',
      completedTeams: [],
      completedMemberPairs: [],
      pendingTeams: [],
      mappings: [],
      edgeCases: [],
      skippedItems: [],
      failureLog: [],
      approvalHistory: [],
    } satisfies CheckpointState
    const elicitation = {
      id: 'elicit-2',
      runId: 'run-1',
      workflowRunId: 'workflow-1',
      hookToken: 'migration-elicitation:elicit-2',
      phase: 'create-teams',
      kind: 'healing',
      status: 'pending',
      summary: 'TransientFailure while attempting create-team for core',
      question: 'Skip failed create-team?',
      choices: ['skip', 'abort'],
      operation: 'create-team',
      target: 'core',
      targetType: 'team',
      failureMode: 'TransientFailure',
      actionOnApprove: 'skip',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:01:00.000Z',
      trace: {
        agentSessionId: 'local-correlation-only',
        sdkProvided: false,
        localCorrelationId: 'local-correlation-only',
        conversationHistory: [],
      },
      operator: {
        principalType: 'user',
        userPrincipalName: 'operator@contoso.com',
      },
      source: {
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
      },
      targetConfiguration: {
        githubOrg: 'contoso',
        apply: true,
        concurrency: 4,
        prefix: '',
        suffix: '',
      },
    } satisfies ElicitationRecord

    const markdown = new EscalationReporter().render({
      checkpoint,
      elicitation,
      generatedAt: '2026-07-29T12:02:00.000Z',
    })

    expect(markdown).toContain(
      'Local correlation ID only — NOT tracked by GitHub and cannot be looked up externally',
    )
    expect(markdown).not.toContain('durable, resumable via the Copilot SDK/CLI')
  })
})
