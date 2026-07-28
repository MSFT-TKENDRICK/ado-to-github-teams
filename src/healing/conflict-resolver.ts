import type {ApprovalManager} from '../checkpoints/approval.js'

export class ConflictResolver {
  public slugify(name: string): string {
    const normalized = name
      .normalize('NFKD')
      .replace(/[\u0300-\u036F]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    const trimmed = normalized.slice(0, 100).replace(/^-|-$/g, '')
    return trimmed.length > 0 ? trimmed : 'team'
  }

  public suggestAlternative(slug: string, existingSlug: string): string {
    const base = this.slugify(slug)
    if (base !== existingSlug) {
      return base
    }

    const withSuffix = this.slugify(`${base}-ado`)
    if (withSuffix !== existingSlug) {
      return withSuffix
    }

    return this.slugify(`${base}-${Date.now().toString(36)}`)
  }

  public async resolveTeamNameConflict(
    adoName: string,
    existingSlug: string,
    approval: ApprovalManager,
  ): Promise<{slug: string; approved: boolean}> {
    const currentSlug = this.slugify(adoName)
    const suggested = this.suggestAlternative(currentSlug, existingSlug)
    const approved = await approval.requestApproval({
      action: 'Resolve team name conflict',
      context: {adoName, existingSlug, suggested},
      displayLines: [
        `Team name conflict detected for "${adoName}"`,
        `Existing slug: ${existingSlug}`,
        `Suggested slug: ${suggested}`,
      ],
      autoApprovable: false,
    })
    return {slug: approved ? suggested : existingSlug, approved}
  }
}
