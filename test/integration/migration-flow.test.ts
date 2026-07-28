import {mkdtemp, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {CheckpointManager} from '../../src/checkpoints/manager.js'
import type {ApprovalManager} from '../../src/checkpoints/approval.js'
import {HealingDispatcher} from '../../src/healing/dispatcher.js'
import {MigrationRunner} from '../../src/commands/migrate.js'
import {MarkdownReporter} from '../../src/reporters/markdown.js'
import type {AdoMember, AdoTeam, MappingResult} from '../../src/types/index.js'
import type {AdoService} from '../../src/services/ado.js'
import type {GitHubService} from '../../src/services/github.js'
import type {TeamMapper} from '../../src/mappers/team-mapper.js'

const baseTeam: AdoTeam = {
  id: 't1',
  name: 'Core',
  projectId: 'p1',
  projectName: 'Platform',
}

const baseMember: AdoMember = {
  id: 'u1',
  displayName: 'Ada',
  uniqueName: 'ada@contoso.com',
  isContainer: false,
}

const baseMapping: MappingResult = {
  adoTeam: baseTeam,
  githubTeam: {
    slug: 'core',
    name: 'Core',
    privacy: 'closed',
  },
  memberMappings: [
    {
      adoIdentity: baseMember,
      githubUser: {login: 'ada', type: 'User'},
      mapped: true,
    },
  ],
  edgeCases: [],
}

function createApprovalManager(): ApprovalManager {
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

function createRunner(args: {
  checkpointDir: string
  mapping?: MappingResult
  createTeam?: GitHubService['createTeam']
  addTeamMember?: GitHubService['addTeamMember']
}): MigrationRunner {
  const adoService = {
    getTeams: vi.fn(async () => [baseTeam]),
    getTeamMembers: vi.fn(async () => [baseMember]),
  } as unknown as AdoService
  const teamMapper = {
    mapTeam: vi.fn(async () => args.mapping ?? baseMapping),
  } as unknown as TeamMapper
  const githubService = {
    createTeam:
      args.createTeam ??
      (vi.fn(async () => ({
        id: 1,
        slug: 'core',
        name: 'Core',
        privacy: 'closed',
      })) as unknown as GitHubService['createTeam']),
    addTeamMember:
      args.addTeamMember ??
      (vi.fn(async () => undefined) as unknown as GitHubService['addTeamMember']),
  } as unknown as GitHubService

  return new MigrationRunner({
    adoService,
    githubService,
    teamMapper,
    checkpointManager: new CheckpointManager(args.checkpointDir),
    approvalManager: createApprovalManager(),
    reporter: new MarkdownReporter(),
    dispatcher: new HealingDispatcher(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
}

describe('migration flow integration', () => {
  it('runs full dry-run and writes report', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ado-gh-migrate-'))
    const runner = createRunner({checkpointDir: temp})
    const outputPath = path.join(temp, 'report.md')

    const result = await runner.run({
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      apply: false,
      output: outputPath,
      yes: true,
    })

    expect(result.reportPath).toBe(outputPath)
    const report = await readFile(outputPath, 'utf8')
    expect(report).toContain('## Run Summary')
    expect(report).toContain('## Mapped Teams')
    expect(report).toContain('core')
  })

  it('heals 429 and 401 by retrying and logs conflict/partial failures', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ado-gh-healing-'))
    let createAttempts = 0
    let addAttempts = 0

    const runner = createRunner({
      checkpointDir: temp,
      createTeam: vi.fn(async () => {
        createAttempts += 1
        if (createAttempts === 1) {
          const error = new Error('rate limited') as Error & {status?: number}
          error.status = 429
          throw error
        }
        if (createAttempts === 2) {
          const error = new Error('token expired') as Error & {status?: number}
          error.status = 401
          throw error
        }
        if (createAttempts === 3) {
          throw new Error('GitHub team validation failed for Core')
        }
        return {id: 1, slug: 'core', name: 'Core', privacy: 'closed'}
      }) as unknown as GitHubService['createTeam'],
      addTeamMember: vi.fn(async () => {
        addAttempts += 1
        if (addAttempts === 1) {
          throw new Error('partial failure: team sync timeout')
        }
      }) as unknown as GitHubService['addTeamMember'],
    })

    const outputPath = path.join(temp, 'apply-report.md')
    await runner.run({
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      apply: true,
      output: outputPath,
      yes: true,
    })

    const report = await readFile(outputPath, 'utf8')
    expect(report).toContain('Failure Log')
    expect(report).toContain('RATE_LIMITED')
    expect(report).toContain('TOKEN_EXPIRED')
    expect(report).toContain('TEAM_NAME_CONFLICT')
    expect(report).toContain('PARTIAL_FAILURE')
  })

  it('saves checkpoint and resumes only remaining work after crash', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'ado-gh-resume-'))
    const mappingOne: MappingResult = baseMapping
    const mappingTwo: MappingResult = {
      ...baseMapping,
      adoTeam: {...baseTeam, id: 't2', name: 'Infra'},
      githubTeam: {...baseMapping.githubTeam, slug: 'infra', name: 'Infra'},
    }

    const mappings = [mappingOne, mappingTwo]
    const createCalls: string[] = []
    const checkpointManager = new CheckpointManager(temp)
    const crashingRunner = new MigrationRunner({
      adoService: {
        getTeams: vi.fn(async () => [mappingOne.adoTeam, mappingTwo.adoTeam]),
        getTeamMembers: vi.fn(async () => [baseMember]),
      } as unknown as AdoService,
      githubService: {
        createTeam: vi.fn(async (team) => {
          createCalls.push(team.slug)
          if (team.slug === 'infra') {
            throw new Error('fatal crash')
          }
          return {id: 1, slug: team.slug, name: team.name, privacy: team.privacy}
        }),
        addTeamMember: vi.fn(async () => undefined),
      } as unknown as GitHubService,
      teamMapper: {
        mapTeam: vi.fn(async (team) => mappings.find((m) => m.adoTeam.id === team.id) ?? mappingOne),
      } as unknown as TeamMapper,
      checkpointManager,
      approvalManager: createApprovalManager(),
      reporter: new MarkdownReporter(),
      dispatcher: new HealingDispatcher(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })

    const failedOutput = path.join(temp, 'failed.md')
    await expect(
      crashingRunner.run({
        adoOrg: 'https://dev.azure.com/contoso',
        adoProject: 'Platform',
        githubOrg: 'contoso',
        apply: true,
        output: failedOutput,
        yes: true,
      }),
    ).rejects.toThrow('fatal crash')

    const checkpoints = await checkpointManager.listCheckpoints()
    expect(checkpoints.length).toBe(1)
    const runId = checkpoints[0]?.runId
    if (!runId) {
      throw new Error('Expected checkpoint runId to exist')
    }

    const resumedCalls: string[] = []
    const resumeRunner = new MigrationRunner({
      adoService: {
        getTeams: vi.fn(async () => [mappingOne.adoTeam, mappingTwo.adoTeam]),
        getTeamMembers: vi.fn(async () => [baseMember]),
      } as unknown as AdoService,
      githubService: {
        createTeam: vi.fn(async (team) => {
          resumedCalls.push(team.slug)
          return {id: 2, slug: team.slug, name: team.name, privacy: team.privacy}
        }),
        addTeamMember: vi.fn(async () => undefined),
      } as unknown as GitHubService,
      teamMapper: {
        mapTeam: vi.fn(async (team) => mappings.find((m) => m.adoTeam.id === team.id) ?? mappingOne),
      } as unknown as TeamMapper,
      checkpointManager,
      approvalManager: createApprovalManager(),
      reporter: new MarkdownReporter(),
      dispatcher: new HealingDispatcher(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })

    await resumeRunner.run({
      adoOrg: 'https://dev.azure.com/contoso',
      adoProject: 'Platform',
      githubOrg: 'contoso',
      apply: true,
      output: path.join(temp, 'resumed.md'),
      yes: true,
      ...(runId ? {resume: runId} : {}),
    })

    expect(createCalls).toEqual(['core', 'infra'])
    expect(resumedCalls).toEqual(['infra'])
  })
})
