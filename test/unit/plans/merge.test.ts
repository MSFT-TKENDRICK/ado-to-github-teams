import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {exportMigrationPlan, createArtifact} from '../../../src/plans/artifact.js'
import {operationHash} from '../../../src/plans/canonical.js'
import {mergeMigrationPlans} from '../../../src/plans/merge.js'
import {applyMigrationPlanPatch, diffMigrationPlans} from '../../../src/plans/patch.js'
import {decodeMigrationPlanArtifact} from '../../../src/plans/schemas.js'
import type {
  AssignMemberPlanOperation,
  CreateTeamPlanOperation,
  MigrationPlanArtifact,
  MigrationPlanConflictDocument,
  MigrationPlanOperation,
} from '../../../src/plans/types.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointState,
  type MappingResult,
} from '../../../src/types/index.js'

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
      {
        adoIdentity: {
          id: 'user-2',
          displayName: 'Grace Hopper',
          uniqueName: 'grace@contoso.com',
          isContainer: false,
        },
        mapped: false,
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

async function exportedPlan(): Promise<MigrationPlanArtifact> {
  return Effect.runPromise(exportMigrationPlan(checkpoint()))
}

async function alternative(
  base: MigrationPlanArtifact,
  transform: (operations: MigrationPlanOperation[]) => MigrationPlanOperation[],
): Promise<MigrationPlanArtifact> {
  return Effect.runPromise(
    createArtifact(
      {
        artifactVersion: base.artifactVersion,
        canonicalizationVersion: base.canonicalizationVersion,
        configurationHash: base.configurationHash,
        topologyDigest: base.topologyDigest,
        sourceSnapshotHash: base.sourceSnapshotHash,
        policy: base.policy,
        sourceSnapshot: base.sourceSnapshot,
      },
      transform([...base.operations]),
      base.planHash,
    ),
  )
}

function replaceTeamName(
  operations: MigrationPlanOperation[],
  name: string,
): MigrationPlanOperation[] {
  return operations.map((operation) =>
    operation.kind === 'create-team' ? {...operation, team: {...operation.team, name}} : operation,
  )
}

function addGrace(operations: MigrationPlanOperation[]): MigrationPlanOperation[] {
  const team = operations.find(
    (operation): operation is CreateTeamPlanOperation => operation.kind === 'create-team',
  )!
  const added: AssignMemberPlanOperation = {
    operationId: `member:${encodeURIComponent(team.operationId)}:user-2`,
    kind: 'assign-member',
    teamOperationId: team.operationId,
    sourceIdentityId: 'user-2',
    login: 'grace',
  }
  return [...operations, added]
}

describe('mergeable migration plans', () => {
  it('exports the same plan regardless of runtime completion and GitHub IDs', async () => {
    const firstState = checkpoint()
    const secondState = structuredClone(firstState)
    secondState.completedTeams = ['platform']
    secondState.completedMemberPairs = ['platform:ada']
    secondState.approvalHistory = [
      {
        action: 'Apply migration',
        context: '{}',
        approved: true,
        timestamp: '2026-01-02T00:00:00.000Z',
      },
    ]
    secondState.teamPlan![0]!.team.id = 42

    const [first, second] = await Promise.all([
      Effect.runPromise(exportMigrationPlan(firstState)),
      Effect.runPromise(exportMigrationPlan(secondState)),
    ])

    expect(second.planHash).toBe(first.planHash)
    expect(second.operations).toEqual(first.operations)
  })

  it('round-trips additions and modifications through a guarded patch', async () => {
    const base = await exportedPlan()
    const changed = await alternative(base, (operations) =>
      addGrace(replaceTeamName(operations, 'Platform Engineering')),
    )

    const patch = await Effect.runPromise(diffMigrationPlans(base, changed))
    const applied = await Effect.runPromise(applyMigrationPlanPatch(base, patch))

    expect(applied.operations).toEqual(changed.operations)
    expect(applied.planHash).toBe(changed.planHash)
    expect(patch.changes).toHaveLength(2)
  })

  it('rejects a patch whose operation precondition is stale', async () => {
    const base = await exportedPlan()
    const changed = await alternative(base, (operations) =>
      replaceTeamName(operations, 'Platform Engineering'),
    )
    const patch = await Effect.runPromise(diffMigrationPlans(base, changed))
    const stalePatch = {
      ...patch,
      changes: patch.changes.map((change) => ({...change, beforeHash: 'b'.repeat(64)})),
    }

    await expect(Effect.runPromise(applyMigrationPlanPatch(base, stalePatch))).rejects.toThrow(
      'Patch precondition failed',
    )
  })

  it('merges disjoint changes commutatively', async () => {
    const base = await exportedPlan()
    const left = await alternative(base, (operations) =>
      replaceTeamName(operations, 'Platform Engineering'),
    )
    const right = await alternative(base, addGrace)

    const leftRight = await Effect.runPromise(mergeMigrationPlans(base, left, right))
    const rightLeft = await Effect.runPromise(mergeMigrationPlans(base, right, left))

    expect(leftRight._tag).toBe('Merged')
    expect(rightLeft._tag).toBe('Merged')
    if (leftRight._tag === 'Merged' && rightLeft._tag === 'Merged') {
      expect(leftRight.artifact.planHash).toBe(rightLeft.artifact.planHash)
      expect(leftRight.artifact.operations).toHaveLength(3)
    }
  })

  it('is idempotent and associative for compatible disjoint alternatives', async () => {
    const base = await exportedPlan()
    const renamed = await alternative(base, (operations) =>
      replaceTeamName(operations, 'Platform Engineering'),
    )
    const added = await alternative(base, addGrace)
    const relogged = await alternative(base, (operations) =>
      operations.map((operation) =>
        operation.kind === 'assign-member' ? {...operation, login: 'ada-lovelace'} : operation,
      ),
    )

    const idempotent = await Effect.runPromise(mergeMigrationPlans(base, renamed, renamed))
    expect(idempotent._tag).toBe('Merged')
    if (idempotent._tag === 'Merged') {
      expect(idempotent.artifact.planHash).toBe(renamed.planHash)
    }

    const renamedAdded = await Effect.runPromise(mergeMigrationPlans(base, renamed, added))
    const addedRelogged = await Effect.runPromise(mergeMigrationPlans(base, added, relogged))
    expect(renamedAdded._tag).toBe('Merged')
    expect(addedRelogged._tag).toBe('Merged')
    if (renamedAdded._tag === 'Merged' && addedRelogged._tag === 'Merged') {
      const leftAssociated = await Effect.runPromise(
        mergeMigrationPlans(base, renamedAdded.artifact, relogged),
      )
      const rightAssociated = await Effect.runPromise(
        mergeMigrationPlans(base, renamed, addedRelogged.artifact),
      )
      expect(leftAssociated._tag).toBe('Merged')
      expect(rightAssociated._tag).toBe('Merged')
      if (leftAssociated._tag === 'Merged' && rightAssociated._tag === 'Merged') {
        expect(leftAssociated.artifact.planHash).toBe(rightAssociated.artifact.planHash)
      }
    }
  })

  it('surfaces same-operation alternatives and applies an explicit side selection', async () => {
    const base = await exportedPlan()
    const left = await alternative(base, (operations) =>
      replaceTeamName(operations, 'Platform Engineering'),
    )
    const right = await alternative(base, (operations) =>
      replaceTeamName(operations, 'Core Platform'),
    )

    const conflicted = await Effect.runPromise(mergeMigrationPlans(base, left, right))
    expect(conflicted._tag).toBe('Conflicted')
    if (conflicted._tag !== 'Conflicted') {
      return
    }
    expect(conflicted.document.conflicts).toHaveLength(1)
    const resolutions: MigrationPlanConflictDocument = {
      ...conflicted.document,
      conflicts: conflicted.document.conflicts.map((conflict) => ({
        ...conflict,
        resolution: 'left',
      })),
    }
    const merged = await Effect.runPromise(mergeMigrationPlans(base, left, right, resolutions))

    expect(merged._tag).toBe('Merged')
    if (merged._tag === 'Merged') {
      expect(
        merged.artifact.operations.find((operation) => operation.kind === 'create-team')?.team.name,
      ).toBe('Platform Engineering')
    }
  })

  it('refuses plans from different configurations', async () => {
    const base = await exportedPlan()
    const incompatible = {...base, configurationHash: 'b'.repeat(64)}
    const rehashed = await Effect.runPromise(
      createArtifact(
        {
          artifactVersion: incompatible.artifactVersion,
          canonicalizationVersion: incompatible.canonicalizationVersion,
          configurationHash: incompatible.configurationHash,
          topologyDigest: incompatible.topologyDigest,
          sourceSnapshotHash: incompatible.sourceSnapshotHash,
          policy: incompatible.policy,
          sourceSnapshot: incompatible.sourceSnapshot,
        },
        incompatible.operations,
      ),
    )

    await expect(Effect.runPromise(mergeMigrationPlans(base, rehashed, base))).rejects.toThrow(
      'different configuration hash',
    )
  })

  it('refuses alternatives derived from an unrelated base', async () => {
    const base = await exportedPlan()
    const unrelated = await Effect.runPromise(
      createArtifact(
        {
          artifactVersion: base.artifactVersion,
          canonicalizationVersion: base.canonicalizationVersion,
          configurationHash: base.configurationHash,
          topologyDigest: base.topologyDigest,
          sourceSnapshotHash: base.sourceSnapshotHash,
          policy: base.policy,
          sourceSnapshot: base.sourceSnapshot,
        },
        replaceTeamName([...base.operations], 'Platform Engineering'),
        'c'.repeat(64),
      ),
    )

    await expect(Effect.runPromise(mergeMigrationPlans(base, unrelated, base))).rejects.toThrow(
      'derived from a different base plan',
    )
  })

  it('fails closed when disjoint edits create a dangling cross-operation reference', async () => {
    const base = await exportedPlan()
    const deletedTeamAndMembers = await alternative(base, () => [])
    const addedMember = await alternative(base, addGrace)

    await expect(
      Effect.runPromise(mergeMigrationPlans(base, deletedTeamAndMembers, addedMember)),
    ).rejects.toThrow('references missing team')
  })

  it('rejects privilege escalation and dangling references after edits', async () => {
    const base = await exportedPlan()
    const repositoryTeam: CreateTeamPlanOperation = {
      operationId: 'team:repository:contoso%2Fapi',
      kind: 'create-team',
      teamKind: 'repository',
      team: {slug: 'api', name: 'API', privacy: 'closed'},
      sourceAdoTeamIds: ['team-1'],
      repository: 'contoso/api',
    }
    await expect(
      Effect.runPromise(
        createArtifact(
          {
            artifactVersion: base.artifactVersion,
            canonicalizationVersion: base.canonicalizationVersion,
            configurationHash: base.configurationHash,
            topologyDigest: 'topology',
            sourceSnapshotHash: base.sourceSnapshotHash,
            policy: {allowAdmin: false},
            sourceSnapshot: base.sourceSnapshot,
          },
          [
            repositoryTeam,
            {
              operationId: 'grant:contoso%2Fapi',
              kind: 'grant-repository',
              teamOperationId: repositoryTeam.operationId,
              repository: 'contoso/api',
              role: 'admin',
              basePermission: 'none',
              visibility: 'private',
            },
          ],
        ),
      ),
    ).rejects.toThrow('forbidden by plan policy')

    const team = base.operations.find((operation) => operation.kind === 'create-team')!
    const invalidPatch = {
      patchVersion: 1 as const,
      canonicalizationVersion: base.canonicalizationVersion,
      basePlanHash: base.planHash,
      changes: [
        {
          operationId: team.operationId,
          beforeHash: operationHash(team),
          replacement: null,
        },
      ],
    }
    await expect(Effect.runPromise(applyMigrationPlanPatch(base, invalidPatch))).rejects.toThrow(
      'references missing team',
    )
  })

  it('rejects malformed serialized artifacts', async () => {
    await expect(
      Effect.runPromise(decodeMigrationPlanArtifact({artifactVersion: 1})),
    ).rejects.toThrow('Malformed migration plan artifact')
  })

  it('rejects checkpoint-only fields in serialized artifacts', async () => {
    const base = await exportedPlan()
    await expect(
      Effect.runPromise(decodeMigrationPlanArtifact({...base, completedTeams: ['platform']})),
    ).rejects.toThrow('unsupported fields')
  })
})
