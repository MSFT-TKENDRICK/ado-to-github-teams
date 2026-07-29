import {createHook, getWorkflowMetadata} from 'workflow'
import type {
  ApprovalDecision,
  MigrationWorkflowInput,
  MigrationWorkflowResult,
} from './contracts.js'
import {approvalToken} from './contracts.js'
import {
  applyMigrationStep,
  prepareMigrationStep,
} from './steps.js'

export async function migrationWorkflow(
  rawInput: MigrationWorkflowInput,
): Promise<MigrationWorkflowResult> {
  "use workflow";
  const {workflowRunId} = getWorkflowMetadata()
  const plan = await prepareMigrationStep(rawInput, workflowRunId)
  if (!rawInput.apply) {
    return {...plan, status: 'planned'}
  }

  using approval = createHook<ApprovalDecision>({
    token: approvalToken(rawInput.runId),
    metadata: {runId: rawInput.runId, type: 'migration-approval'},
  })
  const decision = await approval
  if (!decision.approved) {
    return {...plan, status: 'rejected'}
  }

  const result = await applyMigrationStep(rawInput, workflowRunId)
  return {...result, status: 'completed'}
}
