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

// Test doubles occasionally need to override an already-optional service
// method with the literal `undefined` (not merely omit it) to simulate an
// adapter build that doesn't implement a capability. `Partial<T>` alone
// doesn't allow this under `exactOptionalPropertyTypes`, since an optional
// property's value type doesn't itself include `undefined`. Only
// `isTeamIdpManaged` needs this loosening today.
interface MappingLayerOverrides {
  readonly ado?: Partial<AdoServiceFx>
  readonly approval?: Partial<ApprovalService>
  readonly entra?: Partial<EntraServiceFx>
  readonly github?: Omit<Partial<GitHubServiceFx>, 'isTeamIdpManaged'> & {
    readonly isTeamIdpManaged?: GitHubServiceFx['isTeamIdpManaged'] | undefined
  }
}

export function mappingLayer(overrides: MappingLayerOverrides = {}) {
  const ado: AdoServiceFx = {
    getTeams: () => Effect.succeed([]),
    getTeamMembers: () => Effect.succeed([]),
    resolveGroupOriginId: () => Effect.succeed(null),
    ...overrides.ado,
  }
  const github = {
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
    // Preserve an override that explicitly sets `isTeamIdpManaged: undefined`
    // (simulating an adapter without the capability) even though the
    // resulting property type includes `undefined`, which the plain
    // `GitHubServiceFx` shape (exactOptionalPropertyTypes) disallows for an
    // annotated object literal. The spread above already applied the
    // override; this cast reconciles the type without changing behavior.
  } as GitHubServiceFx
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
