import type {RepositoryRole} from '../types/index.js'

export const MIGRATION_PLAN_ARTIFACT_VERSION = 1 as const
export const MIGRATION_PLAN_CANONICALIZATION_VERSION = 1 as const
export const MIGRATION_PLAN_PATCH_VERSION = 1 as const
export const MIGRATION_PLAN_CONFLICT_VERSION = 1 as const

export interface PlanSourceTeam {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly projectId: string
  readonly projectName: string
}

export interface PlanSourceMembership {
  readonly teamId: string
  readonly identityId: string
  readonly identityFingerprint: string
}

export interface PlanSourceSnapshot {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly teams: readonly PlanSourceTeam[]
  readonly memberships: readonly PlanSourceMembership[]
}

export interface CreateTeamPlanOperation {
  readonly operationId: string
  readonly kind: 'create-team'
  readonly teamKind: 'flat' | 'organizational-unit' | 'project' | 'repository'
  readonly team: {
    readonly slug: string
    readonly name: string
    readonly description?: string
    readonly privacy: 'closed' | 'secret'
  }
  readonly parentOperationId?: string
  readonly sourceAdoTeamIds: readonly string[]
  readonly repository?: string
}

export interface AssignMemberPlanOperation {
  readonly operationId: string
  readonly kind: 'assign-member'
  readonly teamOperationId: string
  readonly sourceIdentityId: string
  readonly login: string
}

export interface GrantRepositoryPlanOperation {
  readonly operationId: string
  readonly kind: 'grant-repository'
  readonly teamOperationId: string
  readonly repository: string
  readonly role: RepositoryRole
  readonly basePermission: 'none' | RepositoryRole
  readonly visibility: 'public' | 'private' | 'internal'
}

export type MigrationPlanOperation =
  CreateTeamPlanOperation | AssignMemberPlanOperation | GrantRepositoryPlanOperation

export interface MigrationPlanArtifact {
  readonly artifactVersion: typeof MIGRATION_PLAN_ARTIFACT_VERSION
  readonly canonicalizationVersion: typeof MIGRATION_PLAN_CANONICALIZATION_VERSION
  readonly configurationHash: string
  readonly topologyDigest: string
  readonly sourceSnapshotHash: string
  readonly basePlanHash: string
  readonly planHash: string
  readonly policy: {
    readonly allowAdmin: boolean
  }
  readonly sourceSnapshot: PlanSourceSnapshot
  readonly operations: readonly MigrationPlanOperation[]
}

export interface MigrationPlanPatchChange {
  readonly operationId: string
  readonly beforeHash: string | null
  readonly replacement: MigrationPlanOperation | null
}

export interface MigrationPlanPatch {
  readonly patchVersion: typeof MIGRATION_PLAN_PATCH_VERSION
  readonly canonicalizationVersion: typeof MIGRATION_PLAN_CANONICALIZATION_VERSION
  readonly basePlanHash: string
  readonly changes: readonly MigrationPlanPatchChange[]
}

export type MigrationPlanConflictKind = 'add-add' | 'delete-modify' | 'modify-modify'
export type MigrationPlanResolutionChoice = 'left' | 'right'

export interface MigrationPlanConflict {
  readonly operationId: string
  readonly kind: MigrationPlanConflictKind
  readonly baseHash: string | null
  readonly leftHash: string | null
  readonly rightHash: string | null
  readonly base?: MigrationPlanOperation
  readonly left?: MigrationPlanOperation
  readonly right?: MigrationPlanOperation
  readonly resolution?: MigrationPlanResolutionChoice
}

export interface MigrationPlanConflictDocument {
  readonly conflictVersion: typeof MIGRATION_PLAN_CONFLICT_VERSION
  readonly canonicalizationVersion: typeof MIGRATION_PLAN_CANONICALIZATION_VERSION
  readonly basePlanHash: string
  readonly leftPlanHash: string
  readonly rightPlanHash: string
  readonly conflicts: readonly MigrationPlanConflict[]
}

export type MigrationPlanMergeResult =
  | {
      readonly _tag: 'Merged'
      readonly artifact: MigrationPlanArtifact
    }
  | {
      readonly _tag: 'Conflicted'
      readonly document: MigrationPlanConflictDocument
    }
