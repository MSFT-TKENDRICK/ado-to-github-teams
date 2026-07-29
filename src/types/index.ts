export interface AdoTeam {
  id: string
  name: string
  description?: string
  projectId: string
  projectName: string
}

export interface AdoMember {
  id: string
  displayName: string
  uniqueName: string
  email?: string
  isContainer: boolean
  descriptor?: string
}

export interface EntraGroup {
  id: string
  displayName: string
  members: EntraIdentity[]
  hasCircularRef: boolean
  nestedGroupCount: number
}

export interface EntraIdentity {
  id: string
  displayName: string
  userPrincipalName: string
  mail?: string
  accountEnabled?: boolean
  isGuest: boolean
}

export interface GitHubTeam {
  id?: number
  slug: string
  name: string
  description?: string
  privacy: 'closed' | 'secret'
}

export interface GitHubUser {
  login: string
  email?: string
  type: 'User' | 'Bot'
  suspended?: boolean
}

export const CHECKPOINT_SCHEMA_VERSION = 1 as const

export type EdgeCaseReason =
  | 'no-ghemu-account'
  | 'guest-user'
  | 'disabled-account'
  | 'unresolved-identity'
  | 'suspended-account'
  | 'ambiguous-match'
  | 'missing-email'
  | 'circular-group-member'
  | 'entra-role-only'
  | 'ado-project-role'
  | 'nested-group-skipped'

export interface EdgeCase {
  reason: EdgeCaseReason
  adoIdentity?: AdoMember | EntraIdentity
  adoTeam?: AdoTeam
  details: string
  recommendation: string
}

export interface MappingResult {
  adoTeam: AdoTeam
  githubTeam: GitHubTeam
  memberMappings: UserMappingResult[]
  edgeCases: EdgeCase[]
}

export interface UserMappingResult {
  adoIdentity: AdoMember
  githubUser?: GitHubUser
  mapped: boolean
  edgeCase?: EdgeCase
}

export interface MigrationReport {
  runId: string
  timestamp: string
  adoOrg: string
  adoProject: string
  githubOrg: string
  dryRun: boolean
  mappings: MappingResult[]
  edgeCases: EdgeCase[]
  skippedItems: SkippedItem[]
  failureLog: FailureLogEntry[]
  approvalHistory: ApprovalRecord[]
  sandbox?: SandboxReportMetadata
}

export interface SandboxReportMetadata {
  scenario: string
  title: string
  configDigest: string
  transcript: SandboxTranscriptEntry[]
}

export interface SandboxTranscriptEntry {
  sequence: number
  fixtureId: string
  operation: string
  arguments: string
  outcome: string
}

export interface SkippedItem {
  type: 'team' | 'member'
  name: string
  reason: string
}

export interface FailureLogEntry {
  failureMode: string
  error: string
  healingAction: string
  target?: string
  automaticRetry?: boolean
  userApproved?: boolean
  resolved: boolean
}

export interface ApprovalRecord {
  action: string
  context: string
  approved: boolean
  timestamp: string
}

export interface CheckpointState {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  configurationHash: string
  runId: string
  timestamp: string
  adoOrg: string
  adoProject: string
  githubOrg: string
  migrationConfig: {
    apply: boolean
    prefix: string
    suffix: string
  }
  phase: 'fetch' | 'map' | 'dry-run' | 'create-teams' | 'assign-members' | 'report'
  completedTeams: string[]
  completedMemberPairs: string[]
  pendingTeams: AdoTeam[]
  mappings: MappingResult[]
  edgeCases: EdgeCase[]
  skippedItems: SkippedItem[]
  failureLog: FailureLogEntry[]
  approvalHistory: ApprovalRecord[]
}

export interface ApprovalRequest {
  action: string
  context: Record<string, unknown>
  displayLines: string[]
  autoApprovable: boolean
}
