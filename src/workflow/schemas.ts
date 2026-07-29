import {Either, Schema} from 'effect'
import type {TeamTopologyConfig} from '../types/index.js'
import type {
  ApprovalDecision,
  ElicitationDecision,
  MigrationWorkflowInput,
} from './contracts.js'
import {
  TeamTopologyConfigSchema,
  topologyValidationMessage,
} from '../effect/migration/topology.js'

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
  topology: Schema.optional(
    Schema.Struct({
      config: TeamTopologyConfigSchema,
      digest: Schema.String,
    }),
  ),
  entraActor: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal(
        'delegated-user',
        'service-principal',
        'managed-identity',
        'workload-identity',
        'unknown',
      ),
      displayName: Schema.String,
      tenantId: Schema.optional(Schema.String),
      clientId: Schema.optional(Schema.String),
    }),
  ),
})

const ApprovalDecisionSchema = Schema.Struct({
  approved: Schema.Boolean,
  approvedBy: Schema.String,
  comment: Schema.optional(Schema.String),
})

const ElicitationDecisionSchema = Schema.Struct({
  elicitationId: Schema.String,
  expectedFingerprint: Schema.String,
  answerId: Schema.String,
  action: Schema.Literal('approve', 'reject', 'retry', 'skip', 'abort'),
  answeredBy: Schema.String,
  comment: Schema.optional(Schema.String),
})

export function decodeMigrationWorkflowInput(
  input: unknown,
): MigrationWorkflowInput {
  const decoded = Schema.decodeUnknownEither(MigrationWorkflowInputSchema)(input)
  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid migration workflow input: ${String(decoded.left)}`)
  }
  const topology =
    decoded.right.topology === undefined
      ? undefined
      : {
          ...decoded.right.topology,
          config: decoded.right.topology.config as TeamTopologyConfig,
        }
  const topologyError = topology
    ? topologyValidationMessage(topology.config)
    : null
  if (topologyError) {
    throw new Error(`Invalid migration workflow input: ${topologyError}`)
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
    ...(topology ? {topology} : {}),
    ...(decoded.right.entraActor === undefined
      ? {}
      : {
          entraActor: {
            kind: decoded.right.entraActor.kind,
            displayName: decoded.right.entraActor.displayName,
            ...(decoded.right.entraActor.tenantId === undefined
              ? {}
              : {tenantId: decoded.right.entraActor.tenantId}),
            ...(decoded.right.entraActor.clientId === undefined
              ? {}
              : {clientId: decoded.right.entraActor.clientId}),
          },
        }),
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

export function decodeElicitationDecision(input: unknown): ElicitationDecision {
  const decoded = Schema.decodeUnknownEither(ElicitationDecisionSchema)(input)
  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid elicitation decision payload: ${String(decoded.left)}`)
  }
  return {
    elicitationId: decoded.right.elicitationId,
    expectedFingerprint: decoded.right.expectedFingerprint,
    answerId: decoded.right.answerId,
    action: decoded.right.action,
    answeredBy: decoded.right.answeredBy,
    ...(decoded.right.comment === undefined
      ? {}
      : {comment: decoded.right.comment}),
  }
}
