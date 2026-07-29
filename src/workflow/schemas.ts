import {Either, Schema} from 'effect'
import type {
  ApprovalDecision,
  MigrationWorkflowInput,
} from './contracts.js'

const MigrationWorkflowInputSchema = Schema.Struct({
  runId: Schema.String,
  adoOrg: Schema.String,
  adoProject: Schema.String,
  githubOrg: Schema.String,
  apply: Schema.Boolean,
  concurrency: Schema.Number,
  workerBaseUrl: Schema.String,
  taskToken: Schema.String,
  workflowRunId: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
})

const ApprovalDecisionSchema = Schema.Struct({
  approved: Schema.Boolean,
  approvedBy: Schema.String,
  comment: Schema.optional(Schema.String),
})

export function decodeMigrationWorkflowInput(
  input: unknown,
): MigrationWorkflowInput {
  const decoded = Schema.decodeUnknownEither(MigrationWorkflowInputSchema)(input)
  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid migration workflow input: ${String(decoded.left)}`)
  }
  return {
    runId: decoded.right.runId,
    adoOrg: decoded.right.adoOrg,
    adoProject: decoded.right.adoProject,
    githubOrg: decoded.right.githubOrg,
    apply: decoded.right.apply,
    concurrency: decoded.right.concurrency,
    workerBaseUrl: decoded.right.workerBaseUrl,
    taskToken: decoded.right.taskToken,
    ...(decoded.right.workflowRunId === undefined
      ? {}
      : {workflowRunId: decoded.right.workflowRunId}),
    ...(decoded.right.output === undefined ? {} : {output: decoded.right.output}),
    ...(decoded.right.prefix === undefined ? {} : {prefix: decoded.right.prefix}),
    ...(decoded.right.suffix === undefined ? {} : {suffix: decoded.right.suffix}),
  }
}

export function decodeApprovalDecision(input: unknown): ApprovalDecision {
  const decoded = Schema.decodeUnknownEither(ApprovalDecisionSchema)(input)
  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid migration approval payload: ${String(decoded.left)}`)
  }
  return {
    approved: decoded.right.approved,
    approvedBy: decoded.right.approvedBy,
    ...(decoded.right.comment === undefined ? {} : {comment: decoded.right.comment}),
  }
}
