import {Effect, Either, Schema} from 'effect'
import {PlanDecodeFailure} from './errors.js'
import {
  MIGRATION_PLAN_ARTIFACT_VERSION,
  MIGRATION_PLAN_CANONICALIZATION_VERSION,
  MIGRATION_PLAN_CONFLICT_VERSION,
  MIGRATION_PLAN_PATCH_VERSION,
  type MigrationPlanArtifact,
  type MigrationPlanConflictDocument,
  type MigrationPlanPatch,
} from './types.js'

const HashSchema = Schema.String
const RepositoryRoleSchema = Schema.Literal('read', 'triage', 'write', 'maintain', 'admin')
const TeamKindSchema = Schema.Literal('flat', 'organizational-unit', 'project', 'repository')

const CreateTeamOperationSchema = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literal('create-team'),
  teamKind: TeamKindSchema,
  team: Schema.Struct({
    slug: Schema.String,
    name: Schema.String,
    description: Schema.optional(Schema.String),
    privacy: Schema.Literal('closed', 'secret'),
  }),
  parentOperationId: Schema.optional(Schema.String),
  sourceAdoTeamIds: Schema.Array(Schema.String),
  repository: Schema.optional(Schema.String),
})

const AssignMemberOperationSchema = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literal('assign-member'),
  teamOperationId: Schema.String,
  sourceIdentityId: Schema.String,
  login: Schema.String,
})

const GrantRepositoryOperationSchema = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literal('grant-repository'),
  teamOperationId: Schema.String,
  repository: Schema.String,
  role: RepositoryRoleSchema,
  basePermission: Schema.Union(Schema.Literal('none'), RepositoryRoleSchema),
  visibility: Schema.Literal('public', 'private', 'internal'),
})

export const MigrationPlanOperationSchema = Schema.Union(
  CreateTeamOperationSchema,
  AssignMemberOperationSchema,
  GrantRepositoryOperationSchema,
)

const SourceSnapshotSchema = Schema.Struct({
  adoOrg: Schema.String,
  adoProject: Schema.String,
  githubOrg: Schema.String,
  teams: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.optional(Schema.String),
      projectId: Schema.String,
      projectName: Schema.String,
    }),
  ),
  memberships: Schema.Array(
    Schema.Struct({
      teamId: Schema.String,
      identityId: Schema.String,
      identityFingerprint: HashSchema,
    }),
  ),
})

export const MigrationPlanArtifactSchema = Schema.Struct({
  artifactVersion: Schema.Literal(MIGRATION_PLAN_ARTIFACT_VERSION),
  canonicalizationVersion: Schema.Literal(MIGRATION_PLAN_CANONICALIZATION_VERSION),
  configurationHash: HashSchema,
  topologyDigest: Schema.String,
  sourceSnapshotHash: HashSchema,
  basePlanHash: HashSchema,
  planHash: HashSchema,
  policy: Schema.Struct({allowAdmin: Schema.Boolean}),
  sourceSnapshot: SourceSnapshotSchema,
  operations: Schema.Array(MigrationPlanOperationSchema),
})

export const MigrationPlanPatchSchema = Schema.Struct({
  patchVersion: Schema.Literal(MIGRATION_PLAN_PATCH_VERSION),
  canonicalizationVersion: Schema.Literal(MIGRATION_PLAN_CANONICALIZATION_VERSION),
  basePlanHash: HashSchema,
  changes: Schema.Array(
    Schema.Struct({
      operationId: Schema.String,
      beforeHash: Schema.NullOr(HashSchema),
      replacement: Schema.NullOr(MigrationPlanOperationSchema),
    }),
  ),
})

const ConflictSchema = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literal('add-add', 'delete-modify', 'modify-modify'),
  baseHash: Schema.NullOr(HashSchema),
  leftHash: Schema.NullOr(HashSchema),
  rightHash: Schema.NullOr(HashSchema),
  base: Schema.optional(MigrationPlanOperationSchema),
  left: Schema.optional(MigrationPlanOperationSchema),
  right: Schema.optional(MigrationPlanOperationSchema),
  resolution: Schema.optional(Schema.Literal('left', 'right')),
})

export const MigrationPlanConflictDocumentSchema = Schema.Struct({
  conflictVersion: Schema.Literal(MIGRATION_PLAN_CONFLICT_VERSION),
  canonicalizationVersion: Schema.Literal(MIGRATION_PLAN_CANONICALIZATION_VERSION),
  basePlanHash: HashSchema,
  leftPlanHash: HashSchema,
  rightPlanHash: HashSchema,
  conflicts: Schema.Array(ConflictSchema),
})

function decodeWithSchema<A>(
  schema: Schema.Schema<A, unknown>,
  input: unknown,
  label: string,
): Effect.Effect<A, PlanDecodeFailure> {
  const decoded = Schema.decodeUnknownEither(schema)(input)
  return Either.isLeft(decoded)
    ? Effect.fail(new PlanDecodeFailure({message: `Malformed ${label}`}))
    : Effect.succeed(decoded.right)
}

export function decodeMigrationPlanArtifact(
  input: unknown,
): Effect.Effect<MigrationPlanArtifact, PlanDecodeFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return Effect.fail(new PlanDecodeFailure({message: 'Malformed migration plan artifact'}))
  }
  const allowedKeys = new Set([
    'artifactVersion',
    'canonicalizationVersion',
    'configurationHash',
    'topologyDigest',
    'sourceSnapshotHash',
    'basePlanHash',
    'planHash',
    'policy',
    'sourceSnapshot',
    'operations',
  ])
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    return Effect.fail(
      new PlanDecodeFailure({message: 'Migration plan artifact contains unsupported fields'}),
    )
  }
  return decodeWithSchema(
    MigrationPlanArtifactSchema as Schema.Schema<MigrationPlanArtifact, unknown>,
    input,
    'migration plan artifact',
  )
}

export function decodeMigrationPlanPatch(
  input: unknown,
): Effect.Effect<MigrationPlanPatch, PlanDecodeFailure> {
  return decodeWithSchema(
    MigrationPlanPatchSchema as Schema.Schema<MigrationPlanPatch, unknown>,
    input,
    'migration plan patch',
  )
}

export function decodeMigrationPlanConflictDocument(
  input: unknown,
): Effect.Effect<MigrationPlanConflictDocument, PlanDecodeFailure> {
  return decodeWithSchema(
    MigrationPlanConflictDocumentSchema as Schema.Schema<MigrationPlanConflictDocument, unknown>,
    input,
    'migration plan conflict document',
  )
}
