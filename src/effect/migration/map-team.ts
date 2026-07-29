import {Effect} from 'effect'
import {ConflictResolver} from '../../healing/conflict-resolver.js'
import type {
  AdoMember,
  AdoTeam,
  EdgeCase,
  MappingResult,
  UserMappingResult,
} from '../../types/index.js'
import {ApprovalRejected, NotFoundFailure, ValidationFailure} from '../errors.js'
import {AdoServiceTag, ApprovalServiceTag, EntraServiceTag, GitHubServiceTag} from '../services.js'
import {createEdgeCase} from './edge-cases.js'
import {mapMember} from './map-member.js'
import type {TeamMappingOptions} from './options.js'

interface MemberMappingBatch {
  readonly mappings: UserMappingResult[]
  readonly edgeCases: EdgeCase[]
}

export function deduplicateMappedMembers(mappings: UserMappingResult[]): UserMappingResult[] {
  const mappedLogins = new Set<string>()
  return mappings.filter((mapping) => {
    const login = mapping.githubUser?.login
    if (!mapping.mapped || !login) {
      return true
    }
    if (mappedLogins.has(login)) {
      return false
    }
    mappedLogins.add(login)
    return true
  })
}

function mapExpandedMember(identity: {
  readonly id: string
  readonly displayName: string
  readonly userPrincipalName: string
  readonly mail?: string
}): AdoMember {
  return {
    id: identity.id,
    displayName: identity.displayName,
    uniqueName: identity.userPrincipalName,
    isContainer: false,
    ...(identity.mail ? {email: identity.mail} : {}),
  }
}

function mapTeamMember(member: AdoMember, team: AdoTeam) {
  return Effect.gen(function* () {
    const ado = yield* AdoServiceTag
    const entra = yield* EntraServiceTag

    if (!member.isContainer) {
      const mapping = yield* mapMember(member, team)
      return {
        mappings: [mapping],
        edgeCases: mapping.edgeCase ? [mapping.edgeCase] : [],
      } satisfies MemberMappingBatch
    }

    const groupDescriptor = member.descriptor ?? member.id
    const groupOriginId = yield* ado.resolveGroupOriginId(groupDescriptor)
    if (!groupOriginId) {
      return yield* Effect.fail(
        new NotFoundFailure({
          service: 'ado',
          message: `Unable to resolve Entra group id for ADO container ${member.displayName}`,
        }),
      )
    }

    const expanded = yield* Effect.either(entra.getGroupMembers(groupOriginId, true))
    if (expanded._tag === 'Left') {
      const details = expanded.left.message
      const normalizedDetails = details.toLowerCase()
      if (
        expanded.left instanceof ValidationFailure &&
        (normalizedDetails.includes('circular') ||
          normalizedDetails.includes('nested group depth limit exceeded'))
      ) {
        const reason = normalizedDetails.includes('circular')
          ? 'circular-group-member'
          : 'nested-group-skipped'
        return {
          mappings: [],
          edgeCases: [createEdgeCase(reason, details, member, team)],
        } satisfies MemberMappingBatch
      }

      return yield* Effect.fail(expanded.left)
    }

    const mappings = yield* Effect.forEach(
      expanded.right,
      (identity) => mapMember(mapExpandedMember(identity), team),
      {concurrency: 1},
    )
    return {
      mappings,
      edgeCases: mappings.flatMap((mapping) => (mapping.edgeCase ? [mapping.edgeCase] : [])),
    } satisfies MemberMappingBatch
  })
}

export function mapTeam(
  team: AdoTeam,
  members: AdoMember[],
  options: TeamMappingOptions,
): Effect.Effect<
  MappingResult,
  import('../errors.js').DomainFailure,
  AdoServiceTag | ApprovalServiceTag | EntraServiceTag | GitHubServiceTag
> {
  return Effect.gen(function* () {
    const github = yield* GitHubServiceTag
    const approval = yield* ApprovalServiceTag
    const resolver = new ConflictResolver()
    const teamName = `${options.prefix ?? ''}${team.name}${options.suffix ?? ''}`.trim()
    let slug = resolver.slugify(teamName)
    const existing = yield* github.getTeamBySlug(slug)

    if (existing && existing.name !== teamName) {
      const suggestedSlug = resolver.suggestAlternative(slug, existing.slug)
      const approved = yield* approval.request({
        action: 'Resolve team name conflict',
        context: {adoName: teamName, existingSlug: existing.slug},
        displayLines: [
          `Conflict for team ${teamName}`,
          `Existing slug: ${existing.slug}`,
          `Suggested slug: ${suggestedSlug}`,
        ],
        autoApprovable: false,
      })
      if (!approved) {
        return yield* Effect.fail(
          new ApprovalRejected({
            action: 'Resolve team name conflict',
            context: JSON.stringify({adoName: teamName, existingSlug: existing.slug}),
          }),
        )
      }
      slug = suggestedSlug
    }

    const mapped = yield* mapTeamMembers(team, members)

    return {
      adoTeam: team,
      githubTeam: {
        slug,
        name: teamName,
        privacy: 'closed',
        ...(team.description ? {description: team.description} : {}),
      },
      memberMappings: mapped.memberMappings,
      edgeCases: mapped.edgeCases,
    }
  })
}

export function mapTeamMembers(
  team: AdoTeam,
  members: AdoMember[],
): Effect.Effect<
  {readonly memberMappings: UserMappingResult[]; readonly edgeCases: EdgeCase[]},
  import('../errors.js').DomainFailure,
  AdoServiceTag | EntraServiceTag | GitHubServiceTag
> {
  return Effect.gen(function* () {
    const batches = yield* Effect.forEach(members, (member) => mapTeamMember(member, team), {
      concurrency: 1,
    })
    return {
      memberMappings: deduplicateMappedMembers(batches.flatMap((batch) => batch.mappings)),
      edgeCases: batches.flatMap((batch) => batch.edgeCases),
    }
  })
}
