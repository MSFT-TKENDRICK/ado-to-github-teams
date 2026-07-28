import type {ApprovalManager} from '../checkpoints/approval.js'
import {ConflictResolver} from '../healing/conflict-resolver.js'
import {GitHubService} from '../services/github.js'
import type {AdoMember, AdoTeam, EdgeCase, MappingResult, UserMappingResult} from '../types/index.js'
import {UserMapper} from './user-mapper.js'

export class TeamMapper {
  public constructor(
    private readonly userMapper: UserMapper,
    private readonly githubService: GitHubService,
    private readonly conflictResolver: ConflictResolver,
    private readonly approval: ApprovalManager,
    private readonly options: {prefix?: string; suffix?: string},
  ) {}

  public async mapTeam(adoTeam: AdoTeam, members: AdoMember[]): Promise<MappingResult> {
    const teamName = `${this.options.prefix ?? ''}${adoTeam.name}${this.options.suffix ?? ''}`.trim()
    let slug = this.conflictResolver.slugify(teamName)

    const existing = await this.githubService.getTeamBySlug(slug)
    const edgeCases: EdgeCase[] = []
    if (existing && existing.name !== teamName) {
      const conflictResolution = await this.conflictResolver.resolveTeamNameConflict(
        teamName,
        existing.slug,
        this.approval,
      )
      slug = conflictResolution.slug
    }

    const githubTeam: MappingResult['githubTeam'] = {
      slug,
      name: teamName,
      privacy: 'closed' as const,
    }
    if (adoTeam.description) {
      githubTeam.description = adoTeam.description
    }

    const memberMappings: UserMappingResult[] = []
    for (const member of members) {
      if (member.isContainer) {
        const expanded = await this.userMapper.mapGroupMember(member)
        memberMappings.push(...expanded.memberMappings)
        edgeCases.push(...expanded.edgeCases.map((edgeCase) => ({...edgeCase, adoTeam})))
        continue
      }
      const mapped = await this.userMapper.mapMember(member)
      memberMappings.push(mapped)
      if (mapped.edgeCase) {
        edgeCases.push({...mapped.edgeCase, adoTeam})
      }
    }

    return {
      adoTeam,
      githubTeam,
      memberMappings,
      edgeCases,
    }
  }
}
