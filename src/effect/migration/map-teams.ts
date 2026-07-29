import {Effect} from 'effect'
import type {
  AdoTeam,
  GitHubTeam,
  MappingResult,
  PlannedTeam,
  RepositoryGrant,
  UserMappingResult,
} from '../../types/index.js'
import {ValidationFailure} from '../errors.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  EntraServiceTag,
  GitHubServiceTag,
} from '../services.js'
import {deduplicateMappedMembers, mapTeam, mapTeamMembers} from './map-team.js'
import type {EffectMigrationOptions, TeamMappingOptions} from './options.js'
import {buildTopologyPlan, repositoryRoleRank} from './topology.js'

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
      const normalizedTeams = teamsBySlug.get(mapping.githubTeam.slug) ?? []
      normalizedTeams.push(mapping.adoTeam.name)
      teamsBySlug.set(mapping.githubTeam.slug, normalizedTeams)
    }
    for (const [slug, normalizedTeams] of teamsBySlug) {
      if (normalizedTeams.length > 1) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Source teams ${normalizedTeams.join(', ')} normalize to the same GitHub slug "${slug}".`,
          }),
        )
      }
    }
    return mappings
  })
}

function requireHierarchyMethod<T>(
  method: T | undefined,
  name: string,
): Effect.Effect<T, ValidationFailure> {
  return method
    ? Effect.succeed(method)
    : Effect.fail(
        new ValidationFailure({
          service: 'github',
          message: `GitHub adapter does not support required hierarchy operation ${name}.`,
        }),
      )
}

export function mapHierarchy(
  teams: AdoTeam[],
  options: EffectMigrationOptions & {
    readonly topology: NonNullable<EffectMigrationOptions['topology']>
  },
): Effect.Effect<
  {
    readonly mappings: MappingResult[]
    readonly teamPlan: PlannedTeam[]
    readonly repositoryGrants: RepositoryGrant[]
  },
  import('../errors.js').DomainFailure,
  AdoServiceTag | EntraServiceTag | GitHubServiceTag
> {
  return Effect.gen(function* () {
    const ado = yield* AdoServiceTag
    const github = yield* GitHubServiceTag
    const plan = yield* buildTopologyPlan(
      options.topology.config,
      options.adoProject,
      options.githubOrg,
      teams,
    )
    const getBasePermission = yield* requireHierarchyMethod(
      github.getOrganizationBasePermission,
      'getOrganizationBasePermission',
    )
    const getRepository = yield* requireHierarchyMethod(
      github.getRepository,
      'getRepository',
    )
    const listTeamRepositories = yield* requireHierarchyMethod(
      github.listTeamRepositories,
      'listTeamRepositories',
    )
    const isTeamIdpManaged = yield* requireHierarchyMethod(
      github.isTeamIdpManaged,
      'isTeamIdpManaged',
    )
    const getTeamRepositoryPermission = yield* requireHierarchyMethod(
      github.getTeamRepositoryPermission,
      'getTeamRepositoryPermission',
    )
    const basePermission = yield* getBasePermission()
    const existingTeams = new Map<string, GitHubTeam | null>()

    for (const planned of plan.teams) {
      const existing = yield* github.getTeamBySlug(planned.team.slug)
      existingTeams.set(planned.team.slug, existing)
      if (!existing) {
        continue
      }
      if (existing.name !== planned.team.name || existing.privacy !== 'closed') {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Existing team ${planned.team.slug} is incompatible with the hierarchy plan.`,
          }),
        )
      }
      if ((existing.parentTeam?.slug ?? undefined) !== planned.parentSlug) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Existing team ${planned.team.slug} has parent ${existing.parentTeam?.slug ?? 'none'}; expected ${planned.parentSlug ?? 'none'}. Re-parenting requires manual review.`,
          }),
        )
      }
      if (yield* isTeamIdpManaged(planned.team.slug)) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Team ${planned.team.slug} is managed by an identity provider and cannot participate in a nested hierarchy.`,
          }),
        )
      }
      if (planned.kind === 'organizational-unit' || planned.kind === 'project') {
        const repositories = yield* listTeamRepositories(planned.team.slug)
        if (repositories.length > 0) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'github',
              message: `Structural team ${planned.team.slug} already has repository access (${repositories.join(', ')}); descendants would inherit it.`,
            }),
          )
        }
      }
    }

    const repositoryGrants: RepositoryGrant[] = []
    for (const grant of plan.grants) {
      const repository = yield* getRepository(grant.repository)
      if (repository.fullName.toLowerCase() !== grant.repository.toLowerCase()) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Repository ${grant.repository} resolved to unexpected target ${repository.fullName}.`,
          }),
        )
      }
      if (repository.archived) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Repository ${repository.fullName} is archived and cannot receive a team grant.`,
          }),
        )
      }
      if (repositoryRoleRank(basePermission) > repositoryRoleRank(grant.role)) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Organization base permission ${basePermission} exceeds proposed ${grant.role} access for ${repository.fullName}.`,
          }),
        )
      }
      if (existingTeams.get(grant.teamSlug)) {
        const existingRole = yield* getTeamRepositoryPermission(
          grant.teamSlug,
          repository.fullName,
        )
        if (existingRole && repositoryRoleRank(existingRole) > repositoryRoleRank(grant.role)) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'github',
              message: `Existing ${existingRole} grant for ${grant.teamSlug}/${repository.fullName} would be downgraded to ${grant.role}.`,
            }),
          )
        }
      }
      repositoryGrants.push({
        ...grant,
        repository: repository.fullName,
        basePermission,
        visibility: repository.visibility,
      })
    }

    const mappings = yield* Effect.forEach(
      plan.teams.filter((planned) => planned.kind === 'repository'),
      (planned) =>
        Effect.gen(function* () {
          const sources = plan.sourcesByLeafSlug.get(planned.team.slug) ?? []
          const batches = yield* Effect.forEach(
            sources,
            (source) =>
              Effect.gen(function* () {
                const members = yield* ado.getTeamMembers(source.projectId, source.id)
                return yield* mapTeamMembers(source, members)
              }),
            {concurrency: Math.max(1, options.concurrency)},
          )
          const primary = sources[0]
          if (!primary) {
            return yield* Effect.fail(
              new ValidationFailure({
                service: 'topology',
                message: `Repository team ${planned.team.slug} has no source ADO team.`,
              }),
            )
          }
          const memberMappings: UserMappingResult[] = deduplicateMappedMembers(
            batches.flatMap((batch) => batch.memberMappings),
          )
          return {
            adoTeam: primary,
            sourceAdoTeams: sources,
            githubTeam: planned.team,
            memberMappings,
            edgeCases: batches.flatMap((batch) => batch.edgeCases),
          } satisfies MappingResult
        }),
      {concurrency: 1},
    )

    return {mappings, teamPlan: plan.teams, repositoryGrants}
  })
}
