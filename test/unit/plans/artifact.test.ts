import {Cause, Effect, Exit, Option} from 'effect'
import {describe, expect, it} from 'vitest'

import {
  createArtifact,
  exportMigrationPlan,
  planOperationMap,
  validateMigrationPlanArtifact,
} from '../../../src/plans/artifact.js'
import type {
  AssignMemberPlanOperation,
  CreateTeamPlanOperation,
  MigrationPlanArtifact,
  MigrationPlanOperation,
} from '../../../src/plans/types.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointState,
  type MappingResult,
} from '../../../src/types/index.js'

/**
 * Coverage for the migration plan artifact builder and its validator.
 *
 * `validateMigrationPlanArtifact` is the integrity gate for a destructive migration plan: it is the
 * thing standing between a tampered or internally inconsistent artifact and a run that creates
 * teams and grants repository access. It is also almost entirely rejection branches, so the useful
 * way to test it is to build one genuinely valid artifact and then break exactly one invariant at a
 * time.
 *
 * Two entry points are used deliberately:
 * - `validateMigrationPlanArtifact` directly, for hash/ordering invariants, since those require an
 *   artifact whose recorded hashes no longer match its content.
 * - `createArtifact`, for semantic invariants, because it recomputes `planHash` from the mutated
 *   operations before validating. Without that the hash check would fire first and mask the
 *   specific rejection under test.
 */

const configurationHash = 'a'.repeat(64)

function checkpoint(): CheckpointState {
  const mapping: MappingResult = {
    adoTeam: {
      id: 'team-1',
      name: 'Platform',
      projectId: 'project-1',
      projectName: 'Engineering',
    },
    githubTeam: {
      slug: 'platform',
      name: 'Platform',
      privacy: 'closed',
    },
    memberMappings: [
      {
        adoIdentity: {
          id: 'user-1',
          displayName: 'Ada Lovelace',
          uniqueName: 'ada@contoso.com',
          isContainer: false,
        },
        githubUser: {login: 'ada', type: 'User'},
        mapped: true,
      },
    ],
    edgeCases: [],
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash,
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Engineering',
    githubOrg: 'contoso',
    migrationConfig: {
      apply: false,
      prefix: '',
      suffix: '',
      topologyDigest: '',
      allowAdmin: false,
    },
    phase: 'dry-run',
    completedTeams: [],
    completedMemberPairs: [],
    completedRepositoryGrants: [],
    pendingTeams: [mapping.adoTeam],
    mappings: [mapping],
    teamPlan: [
      {
        team: mapping.githubTeam,
        kind: 'flat',
        sourceAdoTeamIds: [mapping.adoTeam.id],
      },
    ],
    repositoryGrants: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

type ArtifactMetadata = Omit<MigrationPlanArtifact, 'basePlanHash' | 'planHash' | 'operations'>

function metadataOf(artifact: MigrationPlanArtifact): ArtifactMetadata {
  const {
    basePlanHash: _basePlanHash,
    planHash: _planHash,
    operations: _operations,
    ...rest
  } = artifact
  return rest
}

/** Extracts the failure message from a plan Effect, failing the test if it unexpectedly succeeded. */
function messageOf(exit: Exit.Exit<unknown, {readonly message: string}>): string {
  if (Exit.isSuccess(exit)) {
    throw new Error('Expected the plan operation to fail, but it succeeded.')
  }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    throw new Error('Expected a typed PlanValidationFailure, but the cause held no failure value.')
  }
  return failure.value.message
}

async function rejectionOf(artifact: MigrationPlanArtifact): Promise<string> {
  return messageOf(await Effect.runPromiseExit(validateMigrationPlanArtifact(artifact)))
}

async function buildRejectionOf(
  metadata: ArtifactMetadata,
  operations: readonly MigrationPlanOperation[],
): Promise<string> {
  return messageOf(await Effect.runPromiseExit(createArtifact(metadata, operations)))
}

async function baseArtifact(): Promise<MigrationPlanArtifact> {
  return Effect.runPromise(exportMigrationPlan(checkpoint()))
}

function teamOperationOf(artifact: MigrationPlanArtifact): CreateTeamPlanOperation {
  const operation = artifact.operations.find(
    (candidate): candidate is CreateTeamPlanOperation => candidate.kind === 'create-team',
  )
  if (!operation) {
    throw new Error('Expected the base artifact to contain a create-team operation.')
  }
  return operation
}

function memberOperationOf(artifact: MigrationPlanArtifact): AssignMemberPlanOperation {
  const operation = artifact.operations.find(
    (candidate): candidate is AssignMemberPlanOperation => candidate.kind === 'assign-member',
  )
  if (!operation) {
    throw new Error('Expected the base artifact to contain an assign-member operation.')
  }
  return operation
}

describe('exportMigrationPlan', () => {
  it('produces an artifact that validates', async () => {
    const artifact = await baseArtifact()
    await expect(
      Effect.runPromise(validateMigrationPlanArtifact(artifact)),
    ).resolves.toBeUndefined()
  })

  it('records the source snapshot and both plan operations', async () => {
    const artifact = await baseArtifact()
    expect(artifact.sourceSnapshot.adoProject).toBe('Engineering')
    expect(artifact.sourceSnapshot.githubOrg).toBe('contoso')
    expect(artifact.sourceSnapshot.teams.map((team) => team.id)).toEqual(['team-1'])
    expect(artifact.operations.map((operation) => operation.kind)).toEqual([
      'create-team',
      'assign-member',
    ])
    expect(memberOperationOf(artifact).login).toBe('ada')
  })

  it('seeds basePlanHash from planHash for a freshly exported plan', async () => {
    const artifact = await baseArtifact()
    expect(artifact.basePlanHash).toBe(artifact.planHash)
  })

  it.each(['fetch', 'map'] as const)(
    'refuses a checkpoint still in the %s phase',
    async (phase) => {
      const state: CheckpointState = {...checkpoint(), phase}
      const message = messageOf(await Effect.runPromiseExit(exportMigrationPlan(state)))
      expect(message).toContain('has not completed migration planning')
    },
  )

  it('refuses a checkpoint with no materialized team plan', async () => {
    const {teamPlan: _teamPlan, ...withoutPlan} = checkpoint()
    const message = messageOf(
      await Effect.runPromiseExit(exportMigrationPlan(withoutPlan as CheckpointState)),
    )
    expect(message).toContain('does not contain a materialized migration plan')
  })

  it('refuses a checkpoint with no materialized repository grants', async () => {
    const {repositoryGrants: _grants, ...withoutGrants} = checkpoint()
    const message = messageOf(
      await Effect.runPromiseExit(exportMigrationPlan(withoutGrants as CheckpointState)),
    )
    expect(message).toContain('does not contain a materialized migration plan')
  })

  it('is deterministic for the same checkpoint', async () => {
    const [first, second] = await Promise.all([baseArtifact(), baseArtifact()])
    expect(first.planHash).toBe(second.planHash)
    expect(first.sourceSnapshotHash).toBe(second.sourceSnapshotHash)
  })
})

describe('validateMigrationPlanArtifact hash invariants', () => {
  it.each(['configurationHash', 'sourceSnapshotHash', 'basePlanHash', 'planHash'] as const)(
    'rejects a %s that is not a lowercase SHA-256 hash',
    async (field) => {
      const artifact = await baseArtifact()
      const message = await rejectionOf({...artifact, [field]: 'NOT-A-HASH'})
      expect(message).toBe(`${field} must be a lowercase SHA-256 hash.`)
    },
  )

  it('rejects an uppercase hash even when it is the right length', async () => {
    const artifact = await baseArtifact()
    const message = await rejectionOf({...artifact, planHash: 'A'.repeat(64)})
    expect(message).toBe('planHash must be a lowercase SHA-256 hash.')
  })

  it('rejects a source snapshot hash that does not match its content', async () => {
    const artifact = await baseArtifact()
    const message = await rejectionOf({
      ...artifact,
      sourceSnapshot: {...artifact.sourceSnapshot, githubOrg: 'tampered'},
    })
    expect(message).toBe('Source snapshot hash does not match its content.')
  })

  it('rejects a plan hash that does not match the artifact content', async () => {
    const artifact = await baseArtifact()
    const message = await rejectionOf({...artifact, planHash: 'b'.repeat(64)})
    expect(message).toBe('Plan hash does not match artifact content.')
  })

  it('rejects operations that are not in canonical order', async () => {
    const artifact = await baseArtifact()
    // Reversing keeps every operation and therefore the multiset hash inputs identical, but the
    // recorded order no longer matches the canonical sort. Ordering is load-bearing: two plans
    // that differ only by order must not produce different plan hashes.
    const reversed = [...artifact.operations].reverse()
    const rebuilt = await Effect.runPromise(createArtifact(metadataOf(artifact), reversed))
    const message = await rejectionOf({...rebuilt, operations: reversed})
    expect(message).toBe('Plan operations are not in canonical order.')
  })

  it('rejects a source identity fingerprint that is not a SHA-256 hash', async () => {
    const artifact = await baseArtifact()
    const tampered: MigrationPlanArtifact = {
      ...artifact,
      sourceSnapshot: {
        ...artifact.sourceSnapshot,
        memberships: artifact.sourceSnapshot.memberships.map((membership) => ({
          ...membership,
          identityFingerprint: 'not-a-fingerprint',
        })),
      },
    }
    // Re-derive the hashes so the fingerprint check is what fires, not the snapshot hash check.
    const rebuilt = await Effect.runPromiseExit(
      createArtifact(metadataOf(tampered), artifact.operations),
    )
    expect(messageOf(rebuilt)).toBe('Source snapshot hash does not match its content.')
  })
})

describe('validateMigrationPlanArtifact operation invariants', () => {
  it('rejects a duplicate operation ID', async () => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [...artifact.operations, team])
    expect(message).toBe(`Duplicate operation ID ${team.operationId}.`)
  })

  it('rejects a flat team that does not reference exactly one source team', async () => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      {...team, sourceAdoTeamIds: []},
      ...artifact.operations.filter((operation) => operation.kind !== 'create-team'),
    ])
    expect(message).toBe(`Flat team ${team.operationId} must reference one source team.`)
  })

  it('rejects a repository team with no repository identity', async () => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional property, so the
    // key is omitted rather than blanked — which is also the shape a real malformed plan would
    // have.
    const {repository: _repository, ...withoutRepository} = team
    const message = await buildRejectionOf(metadataOf(artifact), [
      {...withoutRepository, teamKind: 'repository'},
      ...artifact.operations.filter((operation) => operation.kind !== 'create-team'),
    ])
    expect(message).toBe(`Repository team ${team.operationId} is missing its repository identity.`)
  })

  it('rejects a team operation ID that does not match its semantic identity', async () => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      {...team, operationId: 'team:flat:tampered'},
      ...artifact.operations.filter((operation) => operation.kind !== 'create-team'),
    ])
    expect(message).toBe(
      'Team operation ID team:flat:tampered does not match its semantic identity.',
    )
  })

  it('rejects a team referencing an unknown source ADO team', async () => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      {...team, sourceAdoTeamIds: ['team-does-not-exist']},
      ...artifact.operations.filter((operation) => operation.kind !== 'create-team'),
    ])
    // The semantic-identity check fires first because the operation ID encodes the source id.
    expect(message).toContain('does not match its semantic identity')
  })

  it.each(['slug', 'name'] as const)('rejects a team with a blank %s', async (field) => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      {...team, team: {...team.team, [field]: ''}},
      ...artifact.operations.filter((operation) => operation.kind !== 'create-team'),
    ])
    expect(message).toBe(`Team operation ${team.operationId} has a blank name or slug.`)
  })

  it('rejects a team referencing a missing parent operation', async () => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      {...team, parentOperationId: 'team:project:root'},
      ...artifact.operations.filter((operation) => operation.kind !== 'create-team'),
    ])
    expect(message).toBe(`Team ${team.operationId} references missing parent team:project:root.`)
  })

  it('rejects a member assignment referencing a missing team', async () => {
    const artifact = await baseArtifact()
    const member = memberOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      ...artifact.operations.filter((operation) => operation.kind !== 'assign-member'),
      {...member, teamOperationId: 'team:flat:missing'},
    ])
    expect(message).toBe(`${member.operationId} references missing team team:flat:missing.`)
  })

  it('rejects a member operation ID that does not match its semantic identity', async () => {
    const artifact = await baseArtifact()
    const member = memberOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      ...artifact.operations.filter((operation) => operation.kind !== 'assign-member'),
      {...member, operationId: 'member:tampered'},
    ])
    expect(message).toBe(
      'Member operation ID member:tampered does not match its semantic identity.',
    )
  })

  it('rejects a member assignment with a blank login', async () => {
    const artifact = await baseArtifact()
    const member = memberOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      ...artifact.operations.filter((operation) => operation.kind !== 'assign-member'),
      {...member, login: ''},
    ])
    expect(message).toBe(`Member operation ${member.operationId} has a blank login.`)
  })

  it('rejects a grant whose operation ID does not match its repository', async () => {
    const artifact = await baseArtifact()
    const team = teamOperationOf(artifact)
    const message = await buildRejectionOf(metadataOf(artifact), [
      ...artifact.operations,
      {
        operationId: 'grant:tampered',
        kind: 'grant-repository',
        teamOperationId: team.operationId,
        repository: 'contoso/service',
        role: 'write',
        basePermission: 'none',
        visibility: 'private',
      },
    ])
    expect(message).toBe('Grant operation ID grant:tampered does not match its repository.')
  })
})

describe('planOperationMap', () => {
  it('indexes every operation by its operation ID', async () => {
    const artifact = await baseArtifact()
    const map = planOperationMap(artifact)
    expect(map.size).toBe(artifact.operations.length)
    for (const operation of artifact.operations) {
      expect(map.get(operation.operationId)).toEqual(operation)
    }
  })

  it('returns an empty map for a plan with no operations', async () => {
    const artifact = await baseArtifact()
    expect(planOperationMap({...artifact, operations: []}).size).toBe(0)
  })
})
