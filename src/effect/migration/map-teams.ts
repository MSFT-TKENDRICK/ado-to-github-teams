import {Effect} from 'effect'
import type {AdoTeam, MappingResult} from '../../types/index.js'
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
    return yield* Effect.forEach(
      teams,
      (team) =>
        Effect.gen(function* () {
          const members = yield* ado.getTeamMembers(team.projectId, team.id)
          return yield* mapTeam(team, members, options)
        }),
      {concurrency: Math.max(1, options.concurrency)},
    )
  })
}
