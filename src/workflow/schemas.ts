import {Either, Schema} from 'effect'
import type {TeamTopologyConfig} from '../types/index.js'
import type {
  ApprovalDecision,
  MigrationTaskResult,
  MigrationWorkflowInput,
} from './contracts.js'
import type {ElicitationDecision} from './elicitations.js'
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
  taskTokens: Schema.Struct({
    prepare: Schema.String,
    apply: Schema.String,
    escalation: Schema.String,
  }),
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
})

const ApprovalDecisionSchema = Schema.Struct({
  approved: Schema.Boolean,
  approvedBy: Schema.String,
  comment: Schema.optional(Schema.String),
})

const ElicitationDecisionSchema = Schema.Struct({
  action: Schema.Union(
    Schema.Literal('retry'),
    Schema.Literal('skip'),
    Schema.Literal('abort'),
  ),
  decidedBy: Schema.String,
  comment: Schema.optional(Schema.String),
})

const ElicitationResolutionSchema = Schema.Union(
  Schema.Literal('retry'),
  Schema.Literal('skip'),
  Schema.Literal('abort'),
)

export const ElicitationRecordSchema = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  workflowRunId: Schema.String,
  hookToken: Schema.String,
  phase: Schema.String,
  kind: Schema.Union(Schema.Literal('healing'), Schema.Literal('sso')),
  status: Schema.Union(Schema.Literal('pending'), Schema.Literal('resolved')),
  summary: Schema.String,
  question: Schema.String,
  choices: Schema.Array(ElicitationResolutionSchema),
  operation: Schema.String,
  target: Schema.String,
  targetType: Schema.Union(Schema.Literal('team'), Schema.Literal('member')),
  failureMode: Schema.String,
  actionOnApprove: Schema.Union(
    Schema.Literal('retry'),
    Schema.Literal('skip'),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  decision: Schema.optional(ElicitationDecisionSchema),
  resumedAt: Schema.optional(Schema.String),
  trace: Schema.optional(
    Schema.Struct({
      agentSessionId: Schema.String,
      sdkProvided: Schema.Boolean,
      agentMessageId: Schema.optional(Schema.String),
      localCorrelationId: Schema.String,
      conversationHistory: Schema.Array(
        Schema.Struct({
          role: Schema.Union(
            Schema.Literal('system'),
            Schema.Literal('user'),
            Schema.Literal('assistant'),
          ),
          content: Schema.String,
        }),
      ),
    }),
  ),
  operator: Schema.Struct({
    principalType: Schema.Union(
      Schema.Literal('user'),
      Schema.Literal('service-principal'),
      Schema.Literal('managed-identity'),
      Schema.Literal('unknown'),
    ),
    displayName: Schema.optional(Schema.String),
    userPrincipalName: Schema.optional(Schema.String),
    tenantId: Schema.optional(Schema.String),
    objectId: Schema.optional(Schema.String),
    clientId: Schema.optional(Schema.String),
  }),
  source: Schema.Struct({
    adoOrg: Schema.String,
    adoProject: Schema.String,
  }),
  targetConfiguration: Schema.Struct({
    githubOrg: Schema.String,
    apply: Schema.Boolean,
    concurrency: Schema.Number,
    prefix: Schema.String,
    suffix: Schema.String,
  }),
})

const MigrationTaskResultSchema = Schema.Union(
  Schema.Struct({
    runId: Schema.String,
    reportPath: Schema.String,
    status: Schema.Literal('completed'),
  }),
  Schema.Struct({
    runId: Schema.String,
    reportPath: Schema.String,
    status: Schema.Literal('needs-elicitation'),
    elicitation: ElicitationRecordSchema,
  }),
)

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
    taskTokens: decoded.right.taskTokens,
    ...(decoded.right.workflowRunId === undefined
      ? {}
      : {workflowRunId: decoded.right.workflowRunId}),
    ...(decoded.right.output === undefined ? {} : {output: decoded.right.output}),
    ...(decoded.right.prefix === undefined ? {} : {prefix: decoded.right.prefix}),
    ...(decoded.right.suffix === undefined ? {} : {suffix: decoded.right.suffix}),
    ...(topology ? {topology} : {}),
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
    action: decoded.right.action,
    decidedBy: decoded.right.decidedBy,
    ...(decoded.right.comment === undefined
      ? {}
      : {comment: decoded.right.comment}),
  }
}

export function decodeMigrationTaskResult(input: unknown): MigrationTaskResult {
  const decoded = Schema.decodeUnknownEither(MigrationTaskResultSchema)(input)
  if (Either.isLeft(decoded)) {
    throw new Error(`Invalid migration task result: ${String(decoded.left)}`)
  }
  return decoded.right
}
