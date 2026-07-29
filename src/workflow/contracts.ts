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
}

export interface ApprovalDecision {
  readonly approved: boolean
  readonly approvedBy: string
  readonly comment?: string
}

export interface MigrationWorkflowResult {
  readonly runId: string
  readonly reportPath: string
  readonly status: 'planned' | 'rejected' | 'completed'
}

export interface MigrationTaskResult {
  readonly runId: string
  readonly reportPath: string
}

export function approvalToken(runId: string): string {
  return `migration-approval:${runId}`
}
