import {resumeHook} from 'workflow/api'
import type {
  ApprovalDecision,
  ElicitationDecision,
} from './contracts.js'
import {
  markElicitationResumeDelivered,
  persistApproval,
  persistElicitationDecision,
} from './step-runtime.js'

export interface ApprovalRuntimeDependencies {
  readonly persist: (
    runId: string,
    decision: ApprovalDecision,
  ) => Promise<ApprovalDecision>
  readonly resume: (token: string, decision: ApprovalDecision) => Promise<void>
}

export interface ElicitationRuntimeDependencies {
  readonly persist: (
    runId: string,
    decision: ElicitationDecision,
  ) => Promise<ApprovalDecision | null>
  readonly resume: (token: string, decision: ApprovalDecision) => Promise<void>
  readonly markDelivered: (
    runId: string,
    elicitationId: string,
    answerId: string,
  ) => Promise<void>
}

const liveDependencies: ApprovalRuntimeDependencies = {
  persist: persistApproval,
  resume: async (token, decision) => {
    await resumeHook(token, decision)
  },
}

const liveElicitationDependencies: ElicitationRuntimeDependencies = {
  persist: persistElicitationDecision,
  resume: liveDependencies.resume,
  markDelivered: markElicitationResumeDelivered,
}

export async function persistThenResumeElicitation(
  runId: string,
  token: string,
  decision: ElicitationDecision,
  dependencies: ElicitationRuntimeDependencies = liveElicitationDependencies,
): Promise<void> {
  const approval = await dependencies.persist(runId, decision)
  if (approval) {
    await dependencies.resume(token, approval)
    await dependencies.markDelivered(
      runId,
      decision.elicitationId,
      decision.answerId,
    )
  }
}

export async function persistThenResumeApproval(
  runId: string,
  token: string,
  decision: ApprovalDecision,
  dependencies: ApprovalRuntimeDependencies = liveDependencies,
): Promise<void> {
  const persisted = await dependencies.persist(runId, decision)
  await dependencies.resume(token, persisted)
}
