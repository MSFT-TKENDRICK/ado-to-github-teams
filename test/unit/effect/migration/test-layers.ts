import {Effect, Layer} from 'effect'
import type {
  AdoServiceFx,
  ApprovalService,
  EntraServiceFx,
  GitHubServiceFx,
} from '../../../../src/effect/services.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  EntraServiceTag,
  GitHubServiceTag,
} from '../../../../src/effect/services.js'

interface MappingLayerOverrides {
  readonly ado?: Partial<AdoServiceFx>
  readonly approval?: Partial<ApprovalService>
  readonly entra?: Partial<EntraServiceFx>
  readonly github?: Partial<GitHubServiceFx>
}

export function mappingLayer(overrides: MappingLayerOverrides = {}) {
  const ado: AdoServiceFx = {
    getTeams: () => Effect.succeed([]),
    getTeamMembers: () => Effect.succeed([]),
    resolveGroupOriginId: () => Effect.succeed(null),
    ...overrides.ado,
  }
  const github: GitHubServiceFx = {
    getTeamBySlug: () => Effect.succeed(null),
    createTeam: (team) => Effect.succeed(team),
    addTeamMember: () => Effect.void,
    findUserByEmail: () => Effect.succeed(null),
    isUserSuspended: () => Effect.succeed(false),
    getOrganizationBasePermission: () => Effect.succeed('none'),
    getRepository: (repository) =>
      Effect.succeed({
        fullName: repository,
        archived: false,
        visibility: 'private',
      }),
    listTeamRepositories: () => Effect.succeed([]),
    isTeamIdpManaged: () => Effect.succeed(false),
    getTeamRepositoryPermission: () => Effect.succeed(null),
    setTeamRepositoryPermission: () => Effect.void,
    ...overrides.github,
  }
  const entra: EntraServiceFx = {
    getGroupMembers: () => Effect.succeed([]),
    resolveUserByUpn: () => Effect.succeed(null),
    ...overrides.entra,
  }
  const approval: ApprovalService = {
    request: () => Effect.succeed(true),
    history: Effect.succeed([]),
    ...overrides.approval,
  }

  return Layer.mergeAll(
    Layer.succeed(AdoServiceTag, ado),
    Layer.succeed(GitHubServiceTag, github),
    Layer.succeed(EntraServiceTag, entra),
    Layer.succeed(ApprovalServiceTag, approval),
  )
}
