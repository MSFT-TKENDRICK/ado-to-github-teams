import {Effect} from 'effect'
import type {AdoTeam, MappingResult} from '../../types/index.js'
import {ValidationFailure} from '../errors.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  EntraServiceTag,
  GitHubServiceTag,
} from '../services.js'
import {mapTeam} from './map-team.js'
import type {TeamMappingOptions} from './options.js'

export function mapTeams(
  teams: AdoTeam[],
  options: TeamMappingOptions,
): Effect.Effect<
  MappingResult[],
  import('../errors.js').DomainFailure,
  AdoServiceTag | ApprovalServiceTag | EntraServiceTag | GitHubServiceTag
> {
  return Effect.gen(function* () {
    const ado = yield* AdoServiceTag
    const mappings = yield* Effect.forEach(
      teams,
      (team) =>
        Effect.gen(function* () {
          const members = yield* ado.getTeamMembers(team.projectId, team.id)
          return yield* mapTeam(team, members, options)
        }),
      {concurrency: Math.max(1, options.concurrency)},
    )
    const teamsBySlug = new Map<string, string[]>()
    for (const mapping of mappings) {
      const teams = teamsBySlug.get(mapping.githubTeam.slug) ?? []
      teams.push(mapping.adoTeam.name)
      teamsBySlug.set(mapping.githubTeam.slug, teams)
    }
    for (const [slug, teams] of teamsBySlug) {
      if (teams.length > 1) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Source teams ${teams.join(', ')} normalize to the same GitHub slug "${slug}".`,
          }),
        )
      }
    }
    return mappings
  })
}
