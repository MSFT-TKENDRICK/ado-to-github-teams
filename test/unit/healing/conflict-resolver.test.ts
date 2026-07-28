import {describe, expect, it, vi} from 'vitest'
import {ConflictResolver} from '../../../src/healing/conflict-resolver.js'
import type {ApprovalManager} from '../../../src/checkpoints/approval.js'

describe('ConflictResolver', () => {
  const resolver = new ConflictResolver()

  it('slugifies spaces, symbols, unicode, and trims length', () => {
    expect(resolver.slugify('  Core Team  ')).toBe('core-team')
    expect(resolver.slugify('Dévèloper & Ops')).toBe('developer-ops')
    expect(resolver.slugify('---leading---hyphens---')).toBe('leading-hyphens')
    expect(resolver.slugify('***')).toBe('team')
    expect(resolver.slugify('a'.repeat(150)).length).toBe(100)
  })

  it('suggests deterministic alternatives for collisions', () => {
    expect(resolver.suggestAlternative('platform-team', 'platform-team')).toMatch(
      /^platform-team-ado(-[a-z0-9]+)?$/,
    )
    expect(resolver.suggestAlternative('app-team', 'different-team')).toBe('app-team')
  })

  it('returns approved suggested slug when operator approves', async () => {
    const approval = {
      requestApproval: vi.fn().mockResolvedValue(true),
    } as unknown as ApprovalManager
    const result = await resolver.resolveTeamNameConflict('Platform Team', 'platform-team', approval)
    expect(result.approved).toBe(true)
    expect(result.slug).not.toBe('platform-team')
  })

  it('returns existing slug when operator rejects', async () => {
    const approval = {
      requestApproval: vi.fn().mockResolvedValue(false),
    } as unknown as ApprovalManager
    const result = await resolver.resolveTeamNameConflict('Platform Team', 'platform-team', approval)
    expect(result.approved).toBe(false)
    expect(result.slug).toBe('platform-team')
  })
})
