import {describe, expect, it, vi} from 'vitest'
import {
  persistThenResumeElicitation,
  persistThenResumeApproval,
  type ApprovalRuntimeDependencies,
} from '../../../src/workflow/approval-runtime.js'
import type {ElicitationRecord} from '../../../src/workflow/elicitations.js'

describe('approval runtime ordering', () => {
  it('persists approval before resuming the workflow hook', async () => {
    const events: string[] = []
    const dependencies: ApprovalRuntimeDependencies = {
      persist: async (_runId, decision) => {
        events.push('persist')
        return decision
      },
      resume: async () => {
        events.push('resume')
      },
    }

    await persistThenResumeApproval(
      'run-1',
      'migration-approval:run-1',
      {approved: true, approvedBy: 'operator'},
      dependencies,
    )

    expect(events).toEqual(['persist', 'resume'])
  })

  describe('elicitation runtime ordering', () => {
    it('persists, resumes, and records resumption in order', async () => {
      const events: string[] = []
      const decision = {action: 'skip', decidedBy: 'operator'} as const
      const elicitation = {
        id: 'elicit-1',
        runId: 'run-1',
        hookToken: 'migration-elicitation:elicit-1',
        decision,
      } as ElicitationRecord

      await persistThenResumeElicitation('run-1', elicitation.id, decision, {
        persist: async () => {
          events.push('persist')
          return elicitation
        },
        claimResume: async () => {
          events.push('claim')
          return true
        },
        releaseResume: async () => {
          events.push('release')
        },
        resume: async () => {
          events.push('resume')
        },
        markResumed: async () => {
          events.push('mark-resumed')
        },
      })

      expect(events).toEqual(['persist', 'claim', 'resume', 'mark-resumed'])
    })

    it('leaves a persisted decision reconcilable when resume fails', async () => {
      const markResumed = vi.fn(async () => undefined)
      await expect(
        persistThenResumeElicitation(
          'run-1',
          'elicit-1',
          {action: 'abort', decidedBy: 'operator'},
          {
            persist: async () =>
              ({
                id: 'elicit-1',
                runId: 'run-1',
                hookToken: 'migration-elicitation:elicit-1',
                decision: {action: 'abort', decidedBy: 'operator'},
              }) as ElicitationRecord,
            claimResume: async () => true,
            releaseResume: async () => undefined,
            resume: async () => {
              throw new Error('worker stopped before hook resume')
            },
            markResumed,
          },
        ),
      ).rejects.toThrow('worker stopped before hook resume')

      expect(markResumed).not.toHaveBeenCalled()
    })
  })

  it('does not resume when durable persistence fails', async () => {
    const resume = vi.fn(async () => undefined)
    await expect(
      persistThenResumeApproval(
        'run-1',
        'migration-approval:run-1',
        {approved: true, approvedBy: 'operator'},
        {
          persist: async () => {
            throw new Error('database unavailable')
          },
          resume,
        },
      ),
    ).rejects.toThrow('database unavailable')

    expect(resume).not.toHaveBeenCalled()
  })
})
