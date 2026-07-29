import {Effect, Schema} from 'effect'
import {describe, expect, it} from 'vitest'
import {retryTransient} from '../../../src/effect/retry.js'
import {SandboxRuntime} from '../../../src/sandbox/runtime.js'
import type {SandboxScenario} from '../../../src/sandbox/schema.js'

describe('SandboxRuntime', () => {
  it('serializes identical logical requests across their complete retry lifecycle', async () => {
    const args = {groupId: 'shared-group', transitive: true}
    const scenario: SandboxScenario = {
      id: 'concurrent-retry',
      title: 'Concurrent retry',
      description: 'Keeps retry responses with the logical request that started them.',
      gherkin: 'sandbox/migration.feature:Concurrent retry',
      tags: ['retry'],
      mode: 'dry-run',
      scope: {
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
      },
      interactions: [
        {
          id: 'shared-group',
          operation: 'entra.getGroupMembers',
          args,
          responses: [
            {
              error: {
                type: 'TransientFailure',
                message: 'retry once',
                status: 429,
              },
            },
            {value: []},
            {value: []},
          ],
          minCalls: 3,
          maxCalls: 3,
        },
      ],
      approvals: [],
      expected: {outcome: 'success'},
    }
    const runtime = new SandboxRuntime(scenario)
    const request = () =>
      runtime.serialize(
        'entra.getGroupMembers',
        args,
        retryTransient(
          runtime.invoke('entra.getGroupMembers', args, Schema.Array(Schema.Unknown)),
          {baseDelayMs: 1},
        ),
      )

    const results = await Effect.runPromise(
      Effect.all([request(), request()], {concurrency: 'unbounded'}),
    )

    expect(results).toEqual([[], []])
    expect(runtime.callCount('entra.getGroupMembers')).toBe(3)
    await Effect.runPromise(runtime.verify())
  })

  it('fails closed when more than one approval matcher accepts an action', async () => {
    const scenario: SandboxScenario = {
      id: 'ambiguous-approval',
      title: 'Ambiguous approval',
      description: 'Rejects multiple matching configured decisions.',
      gherkin: 'sandbox/migration.feature:Ambiguous approval',
      tags: ['approval'],
      mode: 'apply',
      scope: {
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
      },
      interactions: [],
      approvals: [
        {
          id: 'create-match',
          actionIncludes: 'Create',
          decision: true,
          minCalls: 0,
          maxCalls: 1,
        },
        {
          id: 'team-match',
          actionIncludes: 'teams',
          decision: false,
          minCalls: 0,
          maxCalls: 1,
        },
      ],
      expected: {outcome: 'success'},
    }
    const runtime = new SandboxRuntime(scenario)

    await expect(
      Effect.runPromise(
        runtime.requestApproval({
          action: 'Create 1 teams',
          context: {},
          displayLines: [],
          autoApprovable: false,
        }),
      ),
    ).rejects.toThrow('Multiple sandbox approvals matched')
  })
})
