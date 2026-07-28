import {describe, expect, it, vi, beforeEach} from 'vitest'
import {TeamMapper} from '../../../src/mappers/team-mapper.js'
import {ConflictResolver} from '../../../src/healing/conflict-resolver.js'
import type {ApprovalManager} from '../../../src/checkpoints/approval.js'
import type {AdoMember, AdoTeam, MappingResult} from '../../../src/types/index.js'
import type {GitHubService} from '../../../src/services/github.js'
import type {UserMapper} from '../../../src/mappers/user-mapper.js'

const adoTeam: AdoTeam = {
  id: 'team-1',
  name: 'Core Platform',
  projectId: 'proj-1',
  projectName: 'Sample',
}

function mapperWith(options?: {prefix?: string; suffix?: string}) {
  const userMapper = {
    mapMember: vi.fn<() => Promise<MappingResult['memberMappings'][number]>>().mockResolvedValue({
      adoIdentity: {
        id: 'u1',
        displayName: 'Ada',
        uniqueName: 'ada@contoso.com',
        isContainer: false,
      },
      githubUser: {login: 'ada', type: 'User'},
      mapped: true,
    }),
    mapGroupMember: vi.fn().mockResolvedValue({memberMappings: [], edgeCases: []}),
  } as unknown as UserMapper

  const githubService = {
    getTeamBySlug: vi.fn().mockResolvedValue(null),
  } as unknown as GitHubService

  const approval = {
    requestApproval: vi.fn().mockResolvedValue(true),
  } as unknown as ApprovalManager

  const mapper = new TeamMapper(
    userMapper,
    githubService,
    new ConflictResolver(),
    approval,
    options ?? {},
  )
  return {mapper, userMapper, githubService, approval}
}

describe('TeamMapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('slugifies names with spaces and unicode', async () => {
    const {mapper} = mapperWith()
    const result = await mapper.mapTeam({...adoTeam, name: 'Dév Platform Team'}, [])
    expect(result.githubTeam.slug).toBe('dev-platform-team')
  })

  it('trims overly long slugs', async () => {
    const {mapper} = mapperWith()
    const longName = 'X'.repeat(140)
    const result = await mapper.mapTeam({...adoTeam, name: longName}, [])
    expect(result.githubTeam.slug.length).toBe(100)
  })

  it('applies prefix and suffix', async () => {
    const {mapper} = mapperWith({prefix: 'ado-', suffix: '-team'})
    const result = await mapper.mapTeam({...adoTeam, name: 'Ops'}, [])
    expect(result.githubTeam.name).toBe('ado-Ops-team')
    expect(result.githubTeam.slug).toBe('ado-ops-team')
  })

  it('resolves slug conflicts via approval path', async () => {
    const {mapper, githubService, approval} = mapperWith()
    vi.mocked(githubService.getTeamBySlug).mockResolvedValue({
      id: 2,
      slug: 'core-platform',
      name: 'Existing Team',
      privacy: 'closed',
    })

    const result = await mapper.mapTeam(adoTeam, [])
    expect(vi.mocked(approval.requestApproval)).toHaveBeenCalled()
    expect(result.githubTeam.slug).not.toBe('core-platform')
  })

  it('propagates ADO role detection from user mapping', async () => {
    const {mapper, userMapper} = mapperWith()
    vi.mocked(userMapper.mapMember).mockResolvedValue({
      adoIdentity: {
        id: 'r1',
        displayName: 'Project Administrators',
        uniqueName: 'proj-admin@contoso.com',
        isContainer: false,
      },
      mapped: false,
      edgeCase: {
        reason: 'ado-project-role',
        details: 'Role member',
        recommendation: 'Manual role mapping',
      },
    })

    const member: AdoMember = {
      id: 'r1',
      displayName: 'Project Administrators',
      uniqueName: 'proj-admin@contoso.com',
      isContainer: false,
    }

    const result = await mapper.mapTeam(adoTeam, [member])
    expect(result.edgeCases[0]?.reason).toBe('ado-project-role')
  })
})
