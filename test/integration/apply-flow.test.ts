import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {MigrationRunner} from '../../src/commands/migrate.js'
import {CheckpointManager} from '../../src/checkpoints/manager.js'
import type {ApprovalManager} from '../../src/checkpoints/approval.js'
import {MarkdownReporter} from '../../src/reporters/markdown.js'
import {HealingDispatcher} from '../../src/healing/dispatcher.js'
import type {AdoService} from '../../src/services/ado.js'
import type {GitHubService} from '../../src/services/github.js'
import type {TeamMapper} from '../../src/mappers/team-mapper.js'

function approvalAlwaysYes(): ApprovalManager {
  const history: {
    action: string
    context: string
    approved: boolean
    timestamp: string
  }[] = []
  return {
    requestApproval: vi.fn(async (request) => {
      history.push({
        action: request.action,
        context: JSON.stringify(request.context),
        approved: true,
        timestamp: new Date().toISOString(),
      })
      return true
    }),
    getHistory: vi.fn(() => [...history]),
  } as unknown as ApprovalManager
}

describe('apply flow integration', () => {
  it('executes create-team then add-member in order and deduplicates assignments', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ado-gh-apply-'))
    const events: string[] = []

    const runner = new MigrationRunner({
      adoService: {
        getTeams: vi.fn(async () => [
          {id: 't1', name: 'Core', projectId: 'p1', projectName: 'Platform'},
        ]),
        getTeamMembers: vi.fn(async () => [
          {id: 'u1', displayName: 'Ada', uniqueName: 'ada@contoso.com', isContainer: false},
        ]),
      } as unknown as AdoService,
      githubService: {
        createTeam: vi.fn(async (team) => {
          events.push(`create:${team.slug}`)
          return {id: 1, slug: team.slug, name: team.name, privacy: team.privacy}
        }),
        addTeamMember: vi.fn(async (slug, login) => {
          events.push(`member:${slug}:${login}`)
        }),
      } as unknown as GitHubService,
      teamMapper: {
        mapTeam: vi.fn(async (team) => ({
          adoTeam: team,
          githubTeam: {slug: 'core', name: 'Core', privacy: 'closed'},
          memberMappings: [
            {
              adoIdentity: {
                id: 'u1',
                displayName: 'Ada',
                uniqueName: 'ada@contoso.com',
                isContainer: false,
              },
              githubUser: {login: 'ada', type: 'User'},
              mapped: true,
            },
            {
              adoIdentity: {
                id: 'u1',
                displayName: 'Ada',
                uniqueName: 'ada@contoso.com',
                isContainer: false,
              },
              githubUser: {login: 'ada', type: 'User'},
              mapped: true,
            },
          ],
          edgeCases: [],
        })),
      } as unknown as TeamMapper,
      checkpointManager: new CheckpointManager(temp),
      approvalManager: approvalAlwaysYes(),
      reporter: new MarkdownReporter(),
      dispatcher: new HealingDispatcher(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })

    await runner.run({
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      apply: true,
      output: path.join(temp, 'apply.md'),
      yes: true,
    })

    expect(events[0]).toBe('create:core')
    expect(events.filter((event) => event === 'member:core:ada')).toHaveLength(1)
    expect(events).toEqual(['create:core', 'member:core:ada'])
  })
})
