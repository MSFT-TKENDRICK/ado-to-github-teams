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
  parentTeam?: {
    id: number
    slug: string
  }
}

export interface GitHubUser {
  login: string
  email?: string
  type: 'User' | 'Bot'
  suspended?: boolean
}

export type RepositoryRole = 'read' | 'triage' | 'write' | 'maintain' | 'admin'

export interface TeamTopologyConfig {
  version: 1
  organizationalUnit: {
    name: string
    description?: string
  }
  projectTeam?: {
    name?: string
    description?: string
  }
  repositories: Array<{
    repository: string
    teamName: string
    description?: string
    sourceAdoTeams: string[]
    role: RepositoryRole
  }>
  allowAdmin?: boolean
}

export interface PlannedTeam {
  team: GitHubTeam
  kind: 'flat' | 'organizational-unit' | 'project' | 'repository'
  parentSlug?: string
  sourceAdoTeamIds: string[]
}

export interface RepositoryGrant {
  repository: string
  teamSlug: string
  role: RepositoryRole
  basePermission: 'none' | RepositoryRole
  visibility: 'public' | 'private' | 'internal'
}

export const CHECKPOINT_SCHEMA_VERSION = 2 as const

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
  sourceAdoTeams?: AdoTeam[]
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
  teamPlan?: PlannedTeam[]
  repositoryGrants?: RepositoryGrant[]
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
  failureTag?: string
  error: string
  healingAction: string
  target?: string
  automaticRetry?: boolean
  userApproved?: boolean
  resolved: boolean
}

export type ElicitationResolution = 'retry' | 'skip' | 'abort'

export interface AgentConversationMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Identity portion of an agent trace, honestly distinguishing GitHub Copilot SDK-issued
 * identifiers (durable, resumable, meaningful to look up against the SDK/Copilot CLI) from
 * process-local correlation IDs (useful only for correlating log lines within this run; never
 * durable and never tracked by GitHub).
 */
export interface AgentTraceIdentity {
  /** Real `CopilotSession#sessionId` when the SDK produced one; otherwise equals `localCorrelationId`. */
  agentSessionId: string
  /** True when `agentSessionId`/`agentMessageId` were captured from the installed Copilot SDK. */
  sdkProvided: boolean
  /** Real SDK assistant message ID for the healing completion, when the SDK returned one. */
  agentMessageId?: string | undefined
  /** Process-local correlation ID minted for this healing attempt. Always local-only. */
  localCorrelationId: string
}

export interface AgentTraceContext extends AgentTraceIdentity {
  conversationHistory: readonly AgentConversationMessage[]
}

export interface ApprovalElicitation {
  kind: 'healing' | 'sso'
  operation: string
  target: string
  targetType: 'team' | 'member'
  failureMode: string
  actionOnApprove: Exclude<ElicitationResolution, 'abort'>
  trace?: AgentTraceContext
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
    topologyDigest?: string
    output?: string
    concurrency?: number
  }
  phase:
    | 'fetch'
    | 'map'
    | 'dry-run'
    | 'create-teams'
    | 'assign-members'
    | 'grant-repositories'
    | 'report'
  completedTeams: string[]
  completedMemberPairs: string[]
  completedRepositoryGrants?: string[]
  pendingTeams: AdoTeam[]
  mappings: MappingResult[]
  teamPlan?: PlannedTeam[]
  repositoryGrants?: RepositoryGrant[]
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
  elicitation?: ApprovalElicitation
}
