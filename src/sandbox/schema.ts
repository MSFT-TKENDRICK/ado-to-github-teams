import {Schema} from 'effect'

export const sandboxOperations = [
  'ado.getTeams',
  'ado.getTeamMembers',
  'ado.resolveGroupOriginId',
  'github.getTeamBySlug',
  'github.createTeam',
  'github.addTeamMember',
  'github.findUserByEmail',
  'github.isUserSuspended',
  'entra.getGroupMembers',
  'entra.resolveUserByUpn',
] as const

export type SandboxOperation = (typeof sandboxOperations)[number]

const SandboxOperationSchema = Schema.Literal(...sandboxOperations)
const SandboxIdSchema = Schema.String.pipe(Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))

const SandboxErrorSchema = Schema.Struct({
  type: Schema.Union(
    Schema.Literal('TransientFailure'),
    Schema.Literal('AuthenticationFailure'),
    Schema.Literal('PermissionFailure'),
    Schema.Literal('NotFoundFailure'),
    Schema.Literal('ValidationFailure'),
    Schema.Literal('ConflictFailure'),
  ),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  retryAfterMs: Schema.optional(Schema.Number),
  ssoRequired: Schema.optional(Schema.Boolean),
})

const SandboxResponseSchema = Schema.Union(
  Schema.Struct({value: Schema.Unknown}),
  Schema.Struct({error: SandboxErrorSchema}),
)

const SandboxInteractionSchema = Schema.Struct({
  id: SandboxIdSchema,
  operation: SandboxOperationSchema,
  args: Schema.Unknown,
  responses: Schema.Array(SandboxResponseSchema),
  minCalls: Schema.Number,
  maxCalls: Schema.Number,
  repeatLast: Schema.optional(Schema.Boolean),
})

const SandboxApprovalSchema = Schema.Struct({
  id: SandboxIdSchema,
  actionIncludes: Schema.String,
  decision: Schema.Boolean,
  minCalls: Schema.Number,
  maxCalls: Schema.Number,
})

const SandboxExpectedSchema = Schema.Union(
  Schema.Struct({
    outcome: Schema.Literal('success'),
    reportIncludes: Schema.optional(Schema.Array(Schema.String)),
    transcriptIncludesInOrder: Schema.optional(Schema.Array(Schema.String)),
    callCounts: Schema.optional(Schema.Record({key: Schema.String, value: Schema.Number})),
  }),
  Schema.Struct({
    outcome: Schema.Literal('failure'),
    failureType: Schema.Union(
      Schema.Literal('TransientFailure'),
      Schema.Literal('AuthenticationFailure'),
      Schema.Literal('PermissionFailure'),
      Schema.Literal('NotFoundFailure'),
      Schema.Literal('ValidationFailure'),
      Schema.Literal('ConflictFailure'),
    ),
    failureService: Schema.Union(
      Schema.Literal('ado'),
      Schema.Literal('github'),
      Schema.Literal('entra'),
      Schema.Literal('sandbox'),
    ),
    failureIncludes: Schema.String,
  }),
)

const SandboxScenarioSchema = Schema.Struct({
  id: SandboxIdSchema,
  title: Schema.String,
  description: Schema.String,
  gherkin: Schema.String,
  tags: Schema.Array(Schema.String),
  mode: Schema.Union(Schema.Literal('dry-run'), Schema.Literal('apply')),
  scope: Schema.Struct({
    adoOrg: Schema.String,
    adoProject: Schema.String,
    githubOrg: Schema.String,
  }),
  interactions: Schema.Array(SandboxInteractionSchema),
  approvals: Schema.Array(SandboxApprovalSchema),
  expected: SandboxExpectedSchema,
})

export const SandboxCatalogSchema = Schema.Struct({
  version: Schema.Literal(1),
  scenarios: Schema.Array(SandboxScenarioSchema),
})

export type SandboxCatalog = Schema.Schema.Type<typeof SandboxCatalogSchema>
export type SandboxScenario = Schema.Schema.Type<typeof SandboxScenarioSchema>
export type SandboxInteraction = Schema.Schema.Type<typeof SandboxInteractionSchema>
export type SandboxResponse = Schema.Schema.Type<typeof SandboxResponseSchema>
export type SandboxError = Schema.Schema.Type<typeof SandboxErrorSchema>
export type SandboxApproval = Schema.Schema.Type<typeof SandboxApprovalSchema>
