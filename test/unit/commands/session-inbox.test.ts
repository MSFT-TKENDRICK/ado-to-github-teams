import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {formatSessionChoice, runSessionInbox} from '../../../src/ui/session-inbox.js'
import type {
  ElicitationRecord,
  MigrationSessionSummary,
} from '../../../src/workflow/elicitations.js'

function blockedSession(runId: string): MigrationSessionSummary {
  const elicitation = {
    id: `elicit-${runId}`,
    runId,
    workflowRunId: `workflow-${runId}`,
    hookToken: `migration-elicitation:elicit-${runId}`,
    phase: 'create-teams',
    kind: 'healing',
    status: 'pending',
    summary: `TransientFailure for ${runId}`,
    question: 'Skip this unit?',
    choices: ['skip', 'abort'],
    operation: 'create-team',
    target: 'core',
    targetType: 'team',
    failureMode: 'TransientFailure',
    actionOnApprove: 'skip',
    createdAt: '2026-07-29T12:00:00.000Z',
    updatedAt: '2026-07-29T12:00:00.000Z',
    operator: {principalType: 'user'},
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
  return {
    runId,
    workflowRunId: elicitation.workflowRunId,
    workflowStatus: 'blocked',
    phase: 'create-teams',
    updatedAt: elicitation.updatedAt,
    adoOrg: elicitation.source.adoOrg,
    adoProject: elicitation.source.adoProject,
    githubOrg: elicitation.targetConfiguration.githubOrg,
    blockingElicitations: [elicitation],
  }
}

describe('parallel session inbox', () => {
  it('shows the current stage, next event, and latest update in each choice', () => {
    const choice = formatSessionChoice(blockedSession('run-a'))

    expect(choice).toContain('Current: Creating GitHub teams')
    expect(choice).toContain('Next: Resolve the blocking decision')
    expect(choice).toContain('Updated 2026-07-29T12:00:00.000Z')
  })

  it('switches between blocked sessions and resolves only the selected one', async () => {
    const choices = ['run-a', '__switch__', 'run-b', 'skip', '__exit__']
    const choose = vi.fn(async () => choices.shift() ?? '__exit__')
    const resolveElicitation = vi.fn(() => Effect.void)
    const sessions = [blockedSession('run-a'), blockedSession('run-b')]

    await runSessionInbox({
      worker: {
        list: () => Effect.succeed(sessions),
        resolveElicitation,
      },
      choose,
      log: vi.fn(),
      operator: 'operator@contoso.com',
    })

    expect(resolveElicitation).toHaveBeenCalledOnce()
    expect(resolveElicitation).toHaveBeenCalledWith('run-b', 'elicit-run-b', {
      action: 'skip',
      decidedBy: 'operator@contoso.com',
    })
  })
})
