import {describe, expect, it, vi, beforeEach} from 'vitest'
import type {AdoMember, EntraIdentity, GitHubUser} from '../../../src/types/index.js'
import {UserMapper} from '../../../src/mappers/user-mapper.js'
import type {GitHubService} from '../../../src/services/github.js'
import type {EntraService} from '../../../src/services/entra.js'
import {AmbiguousMatchError} from '../../../src/utils/errors.js'

function member(overrides: Partial<AdoMember> = {}): AdoMember {
  return {
    id: '1',
    displayName: 'Ada Lovelace',
    uniqueName: 'ada@contoso.com',
    isContainer: false,
    ...overrides,
  }
}

function identity(overrides: Partial<EntraIdentity> = {}): EntraIdentity {
  return {
    id: 'e1',
    displayName: 'Ada Lovelace',
    userPrincipalName: 'ada@contoso.com',
    mail: 'ada@contoso.com',
    accountEnabled: true,
    isGuest: false,
    ...overrides,
  }
}

function githubUser(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return {
    login: 'ada',
    email: 'ada@contoso.com',
    type: 'User',
    ...overrides,
  }
}

describe('UserMapper', () => {
  const githubService = {
    findUserByEmail: vi.fn(),
    isUserSuspended: vi.fn(),
  } as unknown as GitHubService
  const entraService = {
    resolveUserByUpn: vi.fn(),
    getGroupMembers: vi.fn(),
  } as unknown as EntraService
  const mapper = new UserMapper(githubService, entraService)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps successfully when all identities resolve', async () => {
    vi.mocked(entraService.resolveUserByUpn).mockResolvedValue(identity())
    vi.mocked(githubService.findUserByEmail).mockResolvedValue(githubUser())
    vi.mocked(githubService.isUserSuspended).mockResolvedValue(false)

    const result = await mapper.mapMember(member())
    expect(result.mapped).toBe(true)
    expect(result.githubUser?.login).toBe('ada')
  })

  it('handles no-ghemu-account', async () => {
    vi.mocked(entraService.resolveUserByUpn).mockResolvedValue(identity())
    vi.mocked(githubService.findUserByEmail).mockResolvedValue(null)

    const result = await mapper.mapMember(member())
    expect(result.edgeCase?.reason).toBe('no-ghemu-account')
  })

  it('handles guest-user', async () => {
    vi.mocked(entraService.resolveUserByUpn).mockResolvedValue(identity({isGuest: true}))

    const result = await mapper.mapMember(member())
    expect(result.edgeCase?.reason).toBe('guest-user')
  })

  it('handles suspended-account', async () => {
    vi.mocked(entraService.resolveUserByUpn).mockResolvedValue(identity())
    vi.mocked(githubService.findUserByEmail).mockResolvedValue(githubUser())
    vi.mocked(githubService.isUserSuspended).mockResolvedValue(true)

    const result = await mapper.mapMember(member())
    expect(result.edgeCase?.reason).toBe('suspended-account')
  })

  it('handles ambiguous-match', async () => {
    vi.mocked(entraService.resolveUserByUpn).mockResolvedValue(identity())
    vi.mocked(githubService.findUserByEmail).mockRejectedValue(
      new AmbiguousMatchError('Ambiguous', ['ada', 'adalovelace']),
    )

    const result = await mapper.mapMember(member())
    expect(result.edgeCase?.reason).toBe('ambiguous-match')
  })

  it('handles missing-email', async () => {
    vi.mocked(entraService.resolveUserByUpn).mockResolvedValue(null)
    const result = await mapper.mapMember(member({uniqueName: 'invalid@upn'}))
    expect(result.edgeCase?.reason).toBe('missing-email')
  })

  it('handles entra-role-only', async () => {
    const result = await mapper.mapMember(
      member({
        displayName: 'Build Service',
        uniqueName: 'build-service',
      }),
    )
    expect(result.edgeCase?.reason).toBe('entra-role-only')
  })

  it('handles ado-project-role', async () => {
    const result = await mapper.mapMember(
      member({
        displayName: 'Project Administrators',
      }),
    )
    expect(result.edgeCase?.reason).toBe('ado-project-role')
  })

  it('handles circular-group-member from group expansion', async () => {
    const circular = new Error('Circular')
    circular.name = 'CIRCULAR_GROUP'
    vi.mocked(entraService.getGroupMembers).mockRejectedValue(circular)
    const result = await mapper.mapGroupMember(member({isContainer: true, descriptor: 'group-1'}))
    expect(result.edgeCases[0]?.reason).toBe('circular-group-member')
  })

  it('handles nested-group-skipped from group expansion', async () => {
    vi.mocked(entraService.getGroupMembers).mockRejectedValue(
      new Error('Nested group depth limit exceeded'),
    )
    const result = await mapper.mapGroupMember(member({isContainer: true, descriptor: 'group-2'}))
    expect(result.edgeCases[0]?.reason).toBe('nested-group-skipped')
  })
})
