import type {TeamTopologyConfig} from '../types/index.js'

export interface MigrationTopologyInput {
  readonly config: TeamTopologyConfig
  readonly digest: string
}

export interface MigrationWorkflowInput {
  readonly runId: string
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly apply: boolean
  readonly concurrency: number
  readonly workerBaseUrl: string
  readonly taskToken: string
  readonly workflowRunId?: string
  readonly output?: string
  readonly prefix?: string
  readonly suffix?: string
  readonly topology?: MigrationTopologyInput
}

export interface ApprovalDecision {
  readonly approved: boolean
  readonly approvedBy: string
  readonly comment?: string
}

export interface MigrationWorkflowResult {
  readonly runId: string
  readonly reportPath: string
  readonly status: 'planned' | 'rejected' | 'completed' | 'escalated'
}

export interface CompletedMigrationTaskResult {
  readonly runId: string
  readonly reportPath: string
  readonly status: 'completed'
}

export interface ContinuedMigrationTaskResult {
  readonly runId: string
  readonly reportPath: string
  readonly status: 'in-progress'
}

export interface BlockedMigrationTaskResult {
  readonly runId: string
  readonly reportPath: string
  readonly status: 'needs-elicitation'
  readonly elicitation: ElicitationRecord
}

export type MigrationTaskResult =
  | CompletedMigrationTaskResult
  | ContinuedMigrationTaskResult
  | BlockedMigrationTaskResult

export function approvalToken(runId: string): string {
  return `migration-approval:${runId}`
}

export type {ElicitationDecision}
import type {
  ElicitationDecision,
  ElicitationRecord,
} from './elicitations.js'
