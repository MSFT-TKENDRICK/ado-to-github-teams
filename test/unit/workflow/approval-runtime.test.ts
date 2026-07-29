import {describe, expect, it, vi} from 'vitest'
import {
  persistThenResumeApproval,
  type ApprovalRuntimeDependencies,
} from '../../../src/workflow/approval-runtime.js'

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
