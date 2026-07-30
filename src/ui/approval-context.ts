import type {ApprovalRequest} from '../types/index.js'
import type {MigrationPlan} from '../workflow/client.js'

export interface MigrationApprovalContext {
  readonly runId: string
  readonly reportPath: string
  readonly plan: MigrationPlan
}

function contextSummary(context: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(context)
  if (entries.length === 0) {
    return 'the proposed migration unit'
  }
  return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')
}

export function renderApprovalRequestContext(request: ApprovalRequest): string[] {
  const proposed =
    request.displayLines.length === 0
      ? ['  - No target writes are proposed.']
      : request.displayLines.map((line) => `  - ${line}`)
  return [
    `Approval required: ${request.action}`,
    `Scope: ${contextSummary(request.context)}`,
    `Exact proposed ${request.autoApprovable ? 'actions' : 'writes'} (${request.displayLines.length}):`,
    ...proposed,
    request.autoApprovable
      ? 'If approved: only the actions listed above are authorized.'
      : 'If approved: only the writes listed above are authorized. Completed units are checkpointed, but target changes are not automatically rolled back.',
    'If declined: this proposed unit is not written, and checkpointed work remains available to review or resume.',
    'Durable record: the decision and its exact context are stored in migration approval history before execution.',
  ]
}

export function approvalPrompt(request: ApprovalRequest): string {
  return request.autoApprovable
    ? 'Approve exactly these actions?'
    : 'Approve exactly these target writes?'
}

function renderMigrationWrites(plan: MigrationPlan): string[] {
  const totalWrites =
    plan.teams.length + plan.memberAssignments.length + plan.repositoryGrants.length
  return [
    `Exact proposed writes (${totalWrites}):`,
    `  Teams (${plan.teams.length}):`,
    ...plan.teams.map(
      (team) =>
        `    - ${team.slug} (${team.name})${team.parentSlug ? `; parent ${team.parentSlug}` : ''}`,
    ),
    `  Memberships (${plan.memberAssignments.length}):`,
    ...plan.memberAssignments.map(
      (assignment) => `    - ${assignment.login} -> ${assignment.team}`,
    ),
    `  Repository permissions (${plan.repositoryGrants.length}):`,
    ...plan.repositoryGrants.map(
      (grant) =>
        `    - ${grant.teamSlug} -> ${grant.repository}: ${grant.role} (organization base ${grant.basePermission}; ${grant.visibility})`,
    ),
  ]
}

export function renderMigrationPlanContext({
  runId,
  reportPath,
  plan,
}: MigrationApprovalContext): string[] {
  return [
    `Planned GitHub changes for ${plan.githubOrg}:`,
    `Migration: ${runId}`,
    ...renderMigrationWrites(plan),
    `No target writes are performed during this review. Mapping exceptions and evidence are recorded in ${reportPath}.`,
  ]
}

export function renderMigrationApprovalContext({
  runId,
  reportPath,
  plan,
}: MigrationApprovalContext): string[] {
  return [
    'Approval required: Apply migration',
    `Scope: GitHub organization ${plan.githubOrg}; migration ${runId}`,
    ...renderMigrationWrites(plan),
    `Excluded work: identities and changes absent from this plan are not authorized. Review ${reportPath} for mapping exceptions before approval.`,
    'If approved: only this plan is authorized. Each resumable unit is checkpointed, but applied GitHub changes are not automatically rolled back.',
    'If declined: no target writes from this plan are performed; the dry-run evidence and checkpoint remain available for review.',
    `Durable record: the decision, approver, and exact plan are stored under migration ${runId}.`,
  ]
}

export function migrationApprovalPrompt(): string {
  return 'Approve exactly this migration plan?'
}
