import {Effect, Either, Schema} from 'effect'
import {CHECKPOINT_SCHEMA_VERSION, type CheckpointState} from '../types/index.js'
import type {Config} from '../auth/manager.js'
import {DecodeFailure} from './errors.js'

export const AdoTeamSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  projectId: Schema.String,
  projectName: Schema.String,
})

export const AdoMemberSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  uniqueName: Schema.String,
  email: Schema.optional(Schema.String),
  isContainer: Schema.Boolean,
  descriptor: Schema.optional(Schema.String),
})

export const GitHubTeamSchema = Schema.Struct({
  id: Schema.optional(Schema.Number),
  slug: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  privacy: Schema.Union(Schema.Literal('closed'), Schema.Literal('secret')),
  parentTeam: Schema.optional(
    Schema.Struct({
      id: Schema.Number,
      slug: Schema.String,
    }),
  ),
})

export const GitHubUserSchema = Schema.Struct({
  login: Schema.String,
  email: Schema.optional(Schema.String),
  type: Schema.Union(Schema.Literal('User'), Schema.Literal('Bot')),
  suspended: Schema.optional(Schema.Boolean),
})

export const EntraIdentitySchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  userPrincipalName: Schema.String,
  mail: Schema.optional(Schema.String),
  accountEnabled: Schema.optional(Schema.Boolean),
  isGuest: Schema.Boolean,
})

const EdgeCaseSchema = Schema.Struct({
  reason: Schema.String,
  adoIdentity: Schema.optional(Schema.Unknown),
  adoTeam: Schema.optional(AdoTeamSchema),
  details: Schema.String,
  recommendation: Schema.String,
})

const UserMappingSchema = Schema.Struct({
  adoIdentity: AdoMemberSchema,
  githubUser: Schema.optional(
    GitHubUserSchema,
  ),
  mapped: Schema.Boolean,
  edgeCase: Schema.optional(EdgeCaseSchema),
})

const MappingResultSchema = Schema.Struct({
  adoTeam: AdoTeamSchema,
  sourceAdoTeams: Schema.optional(Schema.Array(AdoTeamSchema)),
  githubTeam: GitHubTeamSchema,
  memberMappings: Schema.Array(UserMappingSchema),
  edgeCases: Schema.Array(EdgeCaseSchema),
})

const RepositoryRoleSchema = Schema.Union(
  Schema.Literal('read'),
  Schema.Literal('triage'),
  Schema.Literal('write'),
  Schema.Literal('maintain'),
  Schema.Literal('admin'),
)

const PlannedTeamSchema = Schema.Struct({
  team: GitHubTeamSchema,
  kind: Schema.Union(
    Schema.Literal('flat'),
    Schema.Literal('organizational-unit'),
    Schema.Literal('project'),
    Schema.Literal('repository'),
  ),
  parentSlug: Schema.optional(Schema.String),
  sourceAdoTeamIds: Schema.Array(Schema.String),
})

const RepositoryGrantSchema = Schema.Struct({
  repository: Schema.String,
  teamSlug: Schema.String,
  role: RepositoryRoleSchema,
  basePermission: Schema.Union(Schema.Literal('none'), RepositoryRoleSchema),
  visibility: Schema.Union(
    Schema.Literal('public'),
    Schema.Literal('private'),
    Schema.Literal('internal'),
  ),
})

const FailureLogSchema = Schema.Struct({
  failureMode: Schema.String,
  error: Schema.String,
  healingAction: Schema.String,
  userApproved: Schema.optional(Schema.Boolean),
  resolved: Schema.Boolean,
})

const ApprovalRecordSchema = Schema.Struct({
  action: Schema.String,
  context: Schema.String,
  approved: Schema.Boolean,
  timestamp: Schema.String,
})

export const CheckpointStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CHECKPOINT_SCHEMA_VERSION),
  configurationHash: Schema.String,
  runId: Schema.String,
  timestamp: Schema.String,
  adoOrg: Schema.String,
  adoProject: Schema.String,
  githubOrg: Schema.String,
  migrationConfig: Schema.Struct({
    apply: Schema.Boolean,
    prefix: Schema.String,
    suffix: Schema.String,
    topologyDigest: Schema.optional(Schema.String),
  }),
  phase: Schema.Union(
    Schema.Literal('fetch'),
    Schema.Literal('map'),
    Schema.Literal('dry-run'),
    Schema.Literal('create-teams'),
    Schema.Literal('assign-members'),
    Schema.Literal('grant-repositories'),
    Schema.Literal('report'),
  ),
  completedTeams: Schema.Array(Schema.String),
  completedMemberPairs: Schema.Array(Schema.String),
  completedRepositoryGrants: Schema.optional(Schema.Array(Schema.String)),
  pendingTeams: Schema.Array(AdoTeamSchema),
  mappings: Schema.Array(MappingResultSchema),
  teamPlan: Schema.optional(Schema.Array(PlannedTeamSchema)),
  repositoryGrants: Schema.optional(Schema.Array(RepositoryGrantSchema)),
  edgeCases: Schema.Array(EdgeCaseSchema),
  skippedItems: Schema.Array(
    Schema.Struct({
      type: Schema.Union(Schema.Literal('team'), Schema.Literal('member')),
      name: Schema.String,
      reason: Schema.String,
    }),
  ),
  failureLog: Schema.Array(FailureLogSchema),
  approvalHistory: Schema.Array(ApprovalRecordSchema),
})

export const ConfigSchema = Schema.Struct({
  adoPat: Schema.optional(Schema.String),
  githubPat: Schema.optional(Schema.String),
  entraClientId: Schema.optional(Schema.String),
  entraClientSecret: Schema.optional(Schema.String),
  entraClientTenantId: Schema.optional(Schema.String),
})

export function decodeCheckpoint(
  input: unknown,
): Effect.Effect<CheckpointState, DecodeFailure> {
  const decoded = Schema.decodeUnknownEither(CheckpointStateSchema)(input)
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new DecodeFailure({
        service: 'checkpoint',
        message: 'Malformed checkpoint state',
        raw: input,
      }),
    )
  }
  return Effect.succeed(decoded.right as CheckpointState)
}

export function encodeCheckpoint(
  state: CheckpointState,
): Effect.Effect<unknown, DecodeFailure> {
  try {
    const encoded = Schema.encodeSync(CheckpointStateSchema)(state)
    return Effect.succeed(encoded)
  } catch {
    return Effect.fail(
      new DecodeFailure({
        service: 'checkpoint',
        message: 'Unable to encode checkpoint state',
        raw: state,
      }),
    )
  }
}

export function decodeConfig(input: unknown): Effect.Effect<Config, DecodeFailure> {
  const decoded = Schema.decodeUnknownEither(ConfigSchema)(input)
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new DecodeFailure({
        service: 'auth',
        message: 'Malformed config.json',
        raw: input,
      }),
    )
  }
  return Effect.succeed(decoded.right as Config)
}
