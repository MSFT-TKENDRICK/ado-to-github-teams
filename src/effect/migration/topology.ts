import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {Effect, Either, Schema} from 'effect'
import YAML from 'yaml'
import type {
  AdoTeam,
  PlannedTeam,
  RepositoryGrant,
  RepositoryRole,
  TeamTopologyConfig,
} from '../../types/index.js'
import {ConflictResolver} from '../../healing/conflict-resolver.js'
import {DecodeFailure, ValidationFailure} from '../errors.js'

const RepositoryRoleSchema = Schema.Literal('read', 'triage', 'write', 'maintain', 'admin')

const TeamTopologySchema = Schema.Struct({
  version: Schema.Literal(1),
  organizationalUnit: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  projectTeam: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
  repositories: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      teamName: Schema.String,
      description: Schema.optional(Schema.String),
      sourceAdoTeams: Schema.Array(Schema.String),
      role: RepositoryRoleSchema,
    }),
  ),
  allowAdmin: Schema.optional(Schema.Boolean),
})

export interface LoadedTeamTopology {
  readonly config: TeamTopologyConfig
  readonly digest: string
  readonly sourcePath: string
}

function nonBlank(value: string, field: string): Effect.Effect<void, ValidationFailure> {
  return value.trim().length > 0
    ? Effect.void
    : Effect.fail(
        new ValidationFailure({
          service: 'topology',
          message: `${field} must not be blank.`,
        }),
      )
}

export function loadTeamTopology(filePath: string) {
  return Effect.gen(function* () {
    const sourcePath = path.resolve(filePath)
    const text = yield* Effect.tryPromise({
      try: async () => readFile(sourcePath, 'utf8'),
      catch: (error) =>
        new DecodeFailure({
          service: 'topology',
          message: `Unable to read team topology ${sourcePath}`,
          raw: error,
        }),
    })
    const raw = yield* Effect.try({
      try: () => YAML.parse(text) as unknown,
      catch: (error) =>
        new DecodeFailure({
          service: 'topology',
          message: `Unable to parse team topology ${sourcePath}`,
          raw: error,
        }),
    })
    const decoded = Schema.decodeUnknownEither(TeamTopologySchema)(raw)
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(
        new DecodeFailure({
          service: 'topology',
          message: `Malformed team topology ${sourcePath}`,
          raw,
        }),
      )
    }
    const config = decoded.right as TeamTopologyConfig
    yield* nonBlank(config.organizationalUnit.name, 'organizationalUnit.name')
    if (config.repositories.length === 0) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'topology',
          message: 'A team topology must contain at least one repository mapping.',
        }),
      )
    }
    for (const repository of config.repositories) {
      yield* nonBlank(repository.repository, 'repositories[].repository')
      yield* nonBlank(repository.teamName, 'repositories[].teamName')
      if (repository.sourceAdoTeams.length === 0) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'topology',
            message: `Repository ${repository.repository} must name at least one source ADO team.`,
          }),
        )
      }
      for (const sourceTeam of repository.sourceAdoTeams) {
        yield* nonBlank(sourceTeam, 'repositories[].sourceAdoTeams[]')
      }
      if (repository.role === 'admin' && config.allowAdmin !== true) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'topology',
            message: `Repository ${repository.repository} requests admin access but allowAdmin is not true.`,
          }),
        )
      }
    }

    return {
      config,
      digest: createHash('sha256').update(text).digest('hex'),
      sourcePath,
    } satisfies LoadedTeamTopology
  })
}

function normalizeRepository(repository: string, githubOrg: string): string {
  const parts = repository.trim().split('/')
  if (parts.length === 1) {
    return `${githubOrg}/${parts[0]}`
  }
  if (parts.length === 2 && parts[0]?.toLowerCase() === githubOrg.toLowerCase()) {
    return `${githubOrg}/${parts[1]}`
  }
  return ''
}

export function buildTopologyPlan(
  config: TeamTopologyConfig,
  adoProject: string,
  githubOrg: string,
  sourceTeams: AdoTeam[],
): Effect.Effect<
  {
    readonly teams: PlannedTeam[]
    readonly grants: Array<Omit<RepositoryGrant, 'basePermission' | 'visibility'>>
    readonly sourcesByLeafSlug: ReadonlyMap<string, AdoTeam[]>
  },
  ValidationFailure
> {
  return Effect.gen(function* () {
    const resolver = new ConflictResolver()
    const sourceByName = new Map<string, AdoTeam[]>()
    for (const team of sourceTeams) {
      const key = team.name.trim().toLowerCase()
      sourceByName.set(key, [...(sourceByName.get(key) ?? []), team])
    }

    const ouName = config.organizationalUnit.name.trim()
    const projectName = config.projectTeam?.name?.trim() || adoProject.trim()
    const ouSlug = resolver.slugify(ouName)
    const projectSlug = resolver.slugify(projectName)
    const plannedTeams: PlannedTeam[] = [
      {
        team: {
          slug: ouSlug,
          name: ouName,
          privacy: 'closed',
          ...(config.organizationalUnit.description
            ? {description: config.organizationalUnit.description}
            : {}),
        },
        kind: 'organizational-unit',
        sourceAdoTeamIds: [],
      },
      {
        team: {
          slug: projectSlug,
          name: projectName,
          privacy: 'closed',
          ...(config.projectTeam?.description
            ? {description: config.projectTeam.description}
            : {}),
        },
        kind: 'project',
        parentSlug: ouSlug,
        sourceAdoTeamIds: [],
      },
    ]
    const grants: Array<Omit<RepositoryGrant, 'basePermission' | 'visibility'>> = []
    const sourcesByLeafSlug = new Map<string, AdoTeam[]>()
    const usedSlugs = new Set([ouSlug, projectSlug])
    const usedRepositories = new Set<string>()

    if (ouSlug === projectSlug) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'topology',
          message: 'The organizational unit and project team normalize to the same GitHub slug.',
        }),
      )
    }

    for (const entry of config.repositories) {
      const repository = normalizeRepository(entry.repository, githubOrg)
      if (!repository) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'topology',
            message: `Repository ${entry.repository} is outside target organization ${githubOrg}.`,
          }),
        )
      }
      const repositoryKey = repository.toLowerCase()
      if (usedRepositories.has(repositoryKey)) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'topology',
            message: `Repository ${repository} is mapped more than once.`,
          }),
        )
      }
      usedRepositories.add(repositoryKey)

      const leafName = entry.teamName.trim()
      const leafSlug = resolver.slugify(leafName)
      if (usedSlugs.has(leafSlug)) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'topology',
            message: `Team ${leafName} conflicts with another planned team slug "${leafSlug}".`,
          }),
        )
      }
      usedSlugs.add(leafSlug)

      const selected: AdoTeam[] = []
      for (const sourceName of entry.sourceAdoTeams) {
        const matches = sourceByName.get(sourceName.trim().toLowerCase()) ?? []
        if (matches.length !== 1) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'topology',
              message:
                matches.length === 0
                  ? `Source ADO team "${sourceName}" was not found in project ${adoProject}.`
                  : `Source ADO team "${sourceName}" is ambiguous in project ${adoProject}.`,
            }),
          )
        }
        const source = matches[0]
        if (source && !selected.some((team) => team.id === source.id)) {
          selected.push(source)
        }
      }

      plannedTeams.push({
        team: {
          slug: leafSlug,
          name: leafName,
          privacy: 'closed',
          ...(entry.description ? {description: entry.description} : {}),
        },
        kind: 'repository',
        parentSlug: projectSlug,
        sourceAdoTeamIds: selected.map((team) => team.id),
      })
      sourcesByLeafSlug.set(leafSlug, selected)
      grants.push({repository, teamSlug: leafSlug, role: entry.role})
    }

    return {teams: plannedTeams, grants, sourcesByLeafSlug}
  })
}

export function repositoryRoleRank(role: 'none' | RepositoryRole): number {
  return {
    none: 0,
    read: 1,
    triage: 2,
    write: 3,
    maintain: 4,
    admin: 5,
  }[role]
}
