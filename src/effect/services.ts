import {Context} from 'effect'
import type {Effect} from 'effect'
import type {ResolvedCredentials} from '../auth/manager.js'
import type {
  AdoMember,
  AdoTeam,
  ApprovalRecord,
  ApprovalRequest,
  CheckpointState,
  EntraIdentity,
  GitHubTeam,
  GitHubUser,
  MigrationReport,
} from '../types/index.js'
import type {DomainFailure} from './errors.js'
import type {
  HealingInferenceDecision,
  HealingInferenceRequest,
} from './healing.js'
import type {HealingInferenceFailure} from './errors.js'

export interface AuthService {
  readonly resolveCredentials: Effect.Effect<ResolvedCredentials, DomainFailure>
}

export interface AdoServiceFx {
  readonly getTeams: (projectName: string) => Effect.Effect<AdoTeam[], DomainFailure>
  readonly getTeamMembers: (
    projectId: string,
    teamId: string,
  ) => Effect.Effect<AdoMember[], DomainFailure>
  readonly resolveGroupOriginId: (
    descriptor: string,
  ) => Effect.Effect<string | null, DomainFailure>
}

export interface GitHubServiceFx {
  readonly getTeamBySlug: (slug: string) => Effect.Effect<GitHubTeam | null, DomainFailure>
  readonly createTeam: (
    team: Omit<GitHubTeam, 'id' | 'parentTeam'> & {readonly parentTeamId?: number},
  ) => Effect.Effect<GitHubTeam, DomainFailure>
  readonly addTeamMember: (
    teamSlug: string,
    username: string,
  ) => Effect.Effect<void, DomainFailure>
  readonly findUserByEmail: (email: string) => Effect.Effect<GitHubUser | null, DomainFailure>
  readonly isUserSuspended: (login: string) => Effect.Effect<boolean, DomainFailure>
  readonly getOrganizationBasePermission?: () => Effect.Effect<
    'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin',
    DomainFailure
  >
  readonly getRepository?: (
    repository: string,
  ) => Effect.Effect<
    {readonly fullName: string; readonly archived: boolean; readonly visibility: 'public' | 'private' | 'internal'},
    DomainFailure
  >
  readonly listTeamRepositories?: (teamSlug: string) => Effect.Effect<string[], DomainFailure>
  readonly isTeamIdpManaged?: (teamSlug: string) => Effect.Effect<boolean, DomainFailure>
  readonly getTeamRepositoryPermission?: (
    teamSlug: string,
    repository: string,
  ) => Effect.Effect<
    'read' | 'triage' | 'write' | 'maintain' | 'admin' | null,
    DomainFailure
  >
  readonly setTeamRepositoryPermission?: (
    teamSlug: string,
    repository: string,
    role: 'read' | 'triage' | 'write' | 'maintain' | 'admin',
  ) => Effect.Effect<void, DomainFailure>
}

export interface EntraServiceFx {
  readonly getGroupMembers: (
    groupId: string,
    transitive?: boolean,
  ) => Effect.Effect<EntraIdentity[], DomainFailure>
  readonly resolveUserByUpn: (
    upn: string,
  ) => Effect.Effect<EntraIdentity | null, DomainFailure>
}

export interface CheckpointStore {
  readonly save: (state: CheckpointState) => Effect.Effect<void, DomainFailure>
  readonly load: (runId: string) => Effect.Effect<CheckpointState | null, DomainFailure>
  readonly list: Effect.Effect<
    {runId: string; timestamp: string; phase: string}[],
    DomainFailure
  >
  readonly delete: (runId: string) => Effect.Effect<void, DomainFailure>
}

export interface ApprovalService {
  readonly request: (request: ApprovalRequest) => Effect.Effect<boolean, DomainFailure>
  readonly history: Effect.Effect<ApprovalRecord[], never>
}

export interface ReportWriter {
  readonly write: (
    report: MigrationReport,
    outputPath: string,
    durationMs: number,
  ) => Effect.Effect<void, DomainFailure>
}

export interface HealingReasoner {
  readonly assess: (
    request: HealingInferenceRequest,
  ) => Effect.Effect<HealingInferenceDecision, HealingInferenceFailure>
}

export class AuthServiceTag extends Context.Tag('AuthService')<AuthServiceTag, AuthService>() {}
export class AdoServiceTag extends Context.Tag('AdoServiceFx')<AdoServiceTag, AdoServiceFx>() {}
export class GitHubServiceTag extends Context.Tag('GitHubServiceFx')<
  GitHubServiceTag,
  GitHubServiceFx
>() {}
export class EntraServiceTag extends Context.Tag('EntraServiceFx')<
  EntraServiceTag,
  EntraServiceFx
>() {}
export class CheckpointStoreTag extends Context.Tag('CheckpointStore')<
  CheckpointStoreTag,
  CheckpointStore
>() {}
export class ApprovalServiceTag extends Context.Tag('ApprovalService')<
  ApprovalServiceTag,
  ApprovalService
>() {}
export class ReportWriterTag extends Context.Tag('ReportWriter')<
  ReportWriterTag,
  ReportWriter
>() {}
export class HealingReasonerTag extends Context.Tag('HealingReasoner')<
  HealingReasonerTag,
  HealingReasoner
>() {}
