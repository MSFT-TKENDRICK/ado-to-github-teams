import {resumeHook} from 'workflow/api'
import type {ApprovalDecision} from './contracts.js'
import {persistApproval} from './step-runtime.js'

export interface ApprovalRuntimeDependencies {
  readonly persist: (
    runId: string,
    decision: ApprovalDecision,
  ) => Promise<ApprovalDecision>
  readonly resume: (token: string, decision: ApprovalDecision) => Promise<void>
}

const liveDependencies: ApprovalRuntimeDependencies = {
  persist: persistApproval,
  resume: async (token, decision) => {
    await resumeHook(token, decision)
  },
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
