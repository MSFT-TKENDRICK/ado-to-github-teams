import {createHook, getWorkflowMetadata} from 'workflow'
import type {
  ApprovalDecision,
  MigrationWorkflowInput,
  MigrationWorkflowResult,
} from './contracts.js'
import {approvalToken} from './contracts.js'
import {
  applyMigrationStep,
  generateEscalationReportStep,
  prepareMigrationStep,
} from './steps.js'

export async function migrationWorkflow(
  rawInput: MigrationWorkflowInput,
): Promise<MigrationWorkflowResult> {
  "use workflow";
  const {workflowRunId} = getWorkflowMetadata()
  const plan = await prepareMigrationStep(rawInput, workflowRunId)
  if (plan.status !== 'completed') {
    throw new Error('Migration planning unexpectedly requested an elicitation.')
  }
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

  let result = await applyMigrationStep(rawInput, workflowRunId)
  while (result.status === 'needs-elicitation') {
    using elicitation = createHook<import('./elicitations.js').ElicitationDecision>({
      token: result.elicitation.hookToken,
      metadata: {
        runId: rawInput.runId,
        elicitationId: result.elicitation.id,
        type: 'migration-elicitation',
      },
    })
    const elicitationDecision = await elicitation
    if (elicitationDecision.action === 'abort') {
      const escalation = await generateEscalationReportStep(
        rawInput,
        workflowRunId,
        result.elicitation.id,
      )
      return {...escalation, status: 'escalated'}
    }
    result = await applyMigrationStep(rawInput, workflowRunId)
  }
  return {...result, status: 'completed'}
}
