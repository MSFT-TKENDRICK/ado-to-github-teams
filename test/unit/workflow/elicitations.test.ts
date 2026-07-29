import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {checkpointState} from '../effect/migration/test-state.js'
import {
  containedPath,
  ElicitationConflictError,
  ElicitationStaleError,
  redactDiagnosticText,
  registerApplyElicitation,
  registerHealingEscalation,
  renderEscalationReport,
  resolveElicitation,
} from '../../../src/workflow/elicitations.js'

describe('durable elicitations', () => {
  it('registers one stable apply elicitation for the exact persisted plan', () => {
    const state = checkpointState({
      phase: 'dry-run',
      migrationConfig: {
        apply: false,
        prefix: '',
        suffix: '',
        concurrency: 4,
      },
      teamPlan: [
        {
          team: {slug: 'platform', name: 'Platform', privacy: 'closed'},
          kind: 'flat',
          sourceAdoTeamIds: ['team-1'],
        },
      ],
    })

    const registered = registerApplyElicitation(
      state,
      '2026-07-29T14:00:00.000Z',
    )
    const repeated = registerApplyElicitation(
      registered,
      '2026-07-29T14:01:00.000Z',
    )

    expect(registered.migrationConfig.apply).toBe(true)
    expect(registered.elicitations).toHaveLength(1)
    expect(registered.elicitations?.[0]?.status).toBe('pending')
    expect(registered.elicitations?.[0]?.proposedAction).toContain(
      '1 team, 1 member',
    )
    expect(repeated.elicitations).toEqual(registered.elicitations)
  })

  it('rejects stale and conflicting answers while accepting idempotent redelivery', () => {
    const registered = registerApplyElicitation(
      checkpointState({phase: 'dry-run'}),
      '2026-07-29T14:00:00.000Z',
    )
    const elicitation = registered.elicitations?.[0]
    expect(elicitation).toBeDefined()
    if (!elicitation) {
      return
    }

    expect(() =>
      resolveElicitation(
        registered,
        {
          elicitationId: elicitation.id,
          expectedFingerprint: 'stale',
          answerId: 'answer-1',
          action: 'approve',
          answeredBy: 'operator',
        },
        '2026-07-29T14:01:00.000Z',
      ),
    ).toThrow(ElicitationStaleError)

    const resolved = resolveElicitation(
      registered,
      {
        elicitationId: elicitation.id,
        expectedFingerprint: elicitation.contextFingerprint,
        answerId: 'answer-1',
        action: 'approve',
        answeredBy: 'operator',
      },
      '2026-07-29T14:01:00.000Z',
    )
    const redelivered = resolveElicitation(
      resolved,
      {
        elicitationId: elicitation.id,
        expectedFingerprint: elicitation.contextFingerprint,
        answerId: 'answer-1',
        action: 'approve',
        answeredBy: 'operator',
      },
      '2026-07-29T14:02:00.000Z',
    )

    expect(redelivered).toEqual(resolved)
    expect(() =>
      resolveElicitation(
        resolved,
        {
          elicitationId: elicitation.id,
          expectedFingerprint: elicitation.contextFingerprint,
          answerId: 'answer-2',
          action: 'reject',
          answeredBy: 'another-operator',
        },
        '2026-07-29T14:02:00.000Z',
      ),
    ).toThrow(ElicitationConflictError)
  })

  it('renders a complete redacted escalation report', () => {
    const base = checkpointState({
      entraActor: {
        kind: 'delegated-user',
        displayName: 'operator@contoso.com',
        tenantId: 'tenant-1',
        clientId: 'client-1',
      },
      traceContext: {
        migrationSessionId: 'run-1',
        workflowRunId: 'workflow-1',
        durableWorkloadTraceId: 'durable-1',
      },
      agentConversationHistory: [
        {
          timestamp: '2026-07-29T14:00:00.000Z',
          agentSessionId: 'agent-1',
          threadId: 'thread-1',
          role: 'user',
          content: 'Investigate token=super-secret for operator@contoso.com',
        },
      ],
    })
    const registered = registerHealingEscalation(
      base,
      {
        tag: 'PermissionFailure',
        service: 'github',
        message:
          'Forbidden authorization=ghp_secret for operator@contoso.com',
      },
      '2026-07-29T14:01:00.000Z',
      'escalation.md',
    )
    const markdown = renderEscalationReport(
      registered.state,
      registered.elicitation,
    )

    expect(markdown).toContain('## Semantic Error Summary')
    expect(markdown).toContain('## Estimated Resolution Work')
    expect(markdown).toContain('## Entra Migration Actor')
    expect(markdown).toContain('## Trace Identifiers')
    expect(markdown).toContain('## Source and Target Configuration')
    expect(markdown).toContain('## Agent and Subagent Conversation History')
    expect(markdown).toContain('## Failure History')
    expect(markdown).toContain('## Approval History')
    expect(markdown).toContain('workflow-1')
    expect(markdown).toContain('durable-1')
    expect(markdown).not.toContain('super-secret')
    expect(markdown).not.toContain('operator@contoso.com')
  })

  it('redacts bearer credentials and common secret assignments', () => {
    expect(
      redactDiagnosticText(
        'Bearer abc.def token=secret password:also-secret user@example.com',
      ),
    ).toBe(
      'Bearer [REDACTED] token=[REDACTED] password=[REDACTED] [REDACTED EMAIL]',
    )
    expect(
      redactDiagnosticText(
        'ghp_abcdefghijklmnopqrstuvwxyz123456 eyJabc.def.ghi',
      ),
    ).toBe('[REDACTED GITHUB TOKEN] [REDACTED JWT]')
  })

  it('rejects escalation report paths outside the configured directory', () => {
    expect(containedPath('C:\\reports', 'C:\\reports\\run-1.md')).toBe(
      path.resolve('C:\\reports\\run-1.md'),
    )
    expect(containedPath('C:\\reports', 'C:\\secrets.txt')).toBeNull()
  })
})
