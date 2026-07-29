import {randomUUID} from 'node:crypto'
import {resumeHook} from 'workflow/api'
import {CheckpointManager} from '../checkpoints/manager.js'
import type {ApprovalDecision} from './contracts.js'
import type {ElicitationDecision, ElicitationRecord} from './elicitations.js'
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

export interface ElicitationRuntimeDependencies {
  readonly persist: (
    runId: string,
    elicitationId: string,
    decision: ElicitationDecision,
  ) => Promise<ElicitationRecord>
  readonly resume: (
    token: string,
    decision: ElicitationDecision,
  ) => Promise<void>
  readonly claimResume: (
    elicitationId: string,
    owner: string,
    claimedAt: string,
    staleBefore: string,
  ) => Promise<boolean>
  readonly releaseResume: (
    elicitationId: string,
    owner: string,
  ) => Promise<void>
  readonly markResumed: (
    elicitationId: string,
    owner: string,
  ) => Promise<void>
}

function elicitationManager(): CheckpointManager {
  return new CheckpointManager(process.env.WORKFLOW_SQLITE_PATH)
}

const liveElicitationDependencies: ElicitationRuntimeDependencies = {
  persist: async (runId, elicitationId, decision) => {
    const manager = elicitationManager()
    const current = await manager.getElicitation(elicitationId)
    if (!current || current.runId !== runId) {
      throw new Error(
        `Elicitation ${elicitationId} does not belong to migration ${runId}.`,
      )
    }
    return manager.resolveElicitation(elicitationId, decision)
  },
  resume: async (token, decision) => {
    await resumeHook(token, decision)
  },
  claimResume: async (elicitationId, owner, claimedAt, staleBefore) =>
    elicitationManager().claimElicitationResume(
      elicitationId,
      owner,
      claimedAt,
      staleBefore,
    ),
  releaseResume: async (elicitationId, owner) => {
    await elicitationManager().releaseElicitationResume(elicitationId, owner)
  },
  markResumed: async (elicitationId, owner) => {
    await elicitationManager().markElicitationResumed(elicitationId, owner)
  },
}

async function resumePersistedElicitation(
  elicitation: ElicitationRecord,
  decision: ElicitationDecision,
  dependencies: Pick<
    ElicitationRuntimeDependencies,
    'claimResume' | 'releaseResume' | 'resume' | 'markResumed'
  >,
): Promise<void> {
  const owner = randomUUID()
  const claimedAt = new Date()
  const claimed = await dependencies.claimResume(
    elicitation.id,
    owner,
    claimedAt.toISOString(),
    new Date(claimedAt.getTime() - 60_000).toISOString(),
  )
  if (!claimed) {
    return
  }
  try {
    await dependencies.resume(elicitation.hookToken, decision)
    await dependencies.markResumed(elicitation.id, owner)
  } catch (error) {
    await dependencies.releaseResume(elicitation.id, owner)
    throw error
  }
}

export async function persistThenResumeElicitation(
  runId: string,
  elicitationId: string,
  decision: ElicitationDecision,
  dependencies: ElicitationRuntimeDependencies = liveElicitationDependencies,
): Promise<void> {
  const persisted = await dependencies.persist(runId, elicitationId, decision)
  await resumePersistedElicitation(persisted, decision, dependencies)
}

let activeReconciliation: Promise<number> | undefined

export async function reconcileResolvedElicitations(
  dependencies: Pick<
    ElicitationRuntimeDependencies,
    'claimResume' | 'releaseResume' | 'resume' | 'markResumed'
  > = {
    claimResume: liveElicitationDependencies.claimResume,
    releaseResume: liveElicitationDependencies.releaseResume,
    resume: liveElicitationDependencies.resume,
    markResumed: liveElicitationDependencies.markResumed,
  },
): Promise<number> {
  if (activeReconciliation) {
    return activeReconciliation
  }
  const execution = (async () => {
    const pending = await elicitationManager().listPendingResumptions()
    for (const elicitation of pending) {
      if (!elicitation.decision) {
        throw new Error(
          `Resolved elicitation ${elicitation.id} is missing its decision.`,
        )
      }
      await resumePersistedElicitation(
        elicitation,
        elicitation.decision,
        dependencies,
      )
    }
    return pending.length
  })()
  activeReconciliation = execution
  try {
    return await execution
  } finally {
    if (activeReconciliation === execution) {
      activeReconciliation = undefined
    }
  }
}
