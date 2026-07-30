import {Effect} from 'effect'
import type {CheckpointState, PlannedTeam, RepositoryGrant} from '../types/index.js'
import {canonicalHash, compareCanonicalText, sortPlanOperations} from './canonical.js'
import {PlanValidationFailure} from './errors.js'
import {
  MIGRATION_PLAN_ARTIFACT_VERSION,
  MIGRATION_PLAN_CANONICALIZATION_VERSION,
  type AssignMemberPlanOperation,
  type CreateTeamPlanOperation,
  type GrantRepositoryPlanOperation,
  type MigrationPlanArtifact,
  type MigrationPlanOperation,
  type PlanSourceSnapshot,
} from './types.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/

function encodeIdentity(value: string): string {
  return encodeURIComponent(value.normalize('NFC'))
}

function normalizedRepository(repository: string): string {
  return repository.normalize('NFC').toLowerCase()
}

function teamOperationId(
  planned: PlannedTeam,
  grants: readonly RepositoryGrant[],
): Effect.Effect<string, PlanValidationFailure> {
  return Effect.gen(function* () {
    switch (planned.kind) {
      case 'organizational-unit':
        return 'team:organizational-unit:root'
      case 'project':
        return 'team:project:root'
      case 'flat': {
        const sourceId = planned.sourceAdoTeamIds[0]
        if (planned.sourceAdoTeamIds.length !== 1 || !sourceId) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Flat team ${planned.team.slug} must reference exactly one source ADO team.`,
            }),
          )
        }
        return `team:flat:${encodeIdentity(sourceId)}`
      }
      case 'repository': {
        const repositories = grants
          .filter((grant) => grant.teamSlug === planned.team.slug)
          .map((grant) => normalizedRepository(grant.repository))
        if (repositories.length !== 1 || !repositories[0]) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Repository team ${planned.team.slug} must have exactly one repository grant.`,
            }),
          )
        }
        return `team:repository:${encodeIdentity(repositories[0])}`
      }
    }
  })
}

function memberOperationId(teamId: string, sourceIdentityId: string): string {
  return `member:${encodeIdentity(teamId)}:${encodeIdentity(sourceIdentityId)}`
}

function grantOperationId(repository: string): string {
  return `grant:${encodeIdentity(normalizedRepository(repository))}`
}

function sourceSnapshot(
  state: CheckpointState,
): Effect.Effect<PlanSourceSnapshot, PlanValidationFailure> {
  return Effect.gen(function* () {
    const teams = state.pendingTeams
      .map((team) => ({
        id: team.id.normalize('NFC'),
        name: team.name.normalize('NFC'),
        ...(team.description ? {description: team.description.normalize('NFC')} : {}),
        projectId: team.projectId.normalize('NFC'),
        projectName: team.projectName.normalize('NFC'),
      }))
      .sort((left, right) => compareCanonicalText(left.id, right.id))
    const membershipFingerprints = new Map<string, string>()
    const memberships = state.mappings.flatMap((mapping) =>
      (mapping.sourceAdoTeams ?? [mapping.adoTeam]).flatMap((sourceTeam) =>
        mapping.memberMappings.map((member) => ({
          teamId: sourceTeam.id.normalize('NFC'),
          identityId: member.adoIdentity.id.normalize('NFC'),
          identityFingerprint: canonicalHash({
            id: member.adoIdentity.id,
            displayName: member.adoIdentity.displayName,
            uniqueName: member.adoIdentity.uniqueName,
            email: member.adoIdentity.email,
            isContainer: member.adoIdentity.isContainer,
            descriptor: member.adoIdentity.descriptor,
          }),
        })),
      ),
    )
    const uniqueMemberships = []
    for (const membership of memberships) {
      const key = `${membership.teamId}\0${membership.identityId}`
      const existing = membershipFingerprints.get(key)
      if (existing && existing !== membership.identityFingerprint) {
        return yield* Effect.fail(
          new PlanValidationFailure({
            message: `Source identity ${membership.identityId} has inconsistent snapshots for team ${membership.teamId}.`,
          }),
        )
      }
      if (!existing) {
        membershipFingerprints.set(key, membership.identityFingerprint)
        uniqueMemberships.push(membership)
      }
    }
    uniqueMemberships.sort(
      (left, right) =>
        compareCanonicalText(left.teamId, right.teamId) ||
        compareCanonicalText(left.identityId, right.identityId),
    )

    return {
      adoOrg: state.adoOrg.normalize('NFC'),
      adoProject: state.adoProject.normalize('NFC'),
      githubOrg: state.githubOrg.normalize('NFC'),
      teams,
      memberships: uniqueMemberships,
    }
  })
}

function artifactHashInput(
  artifact: Omit<MigrationPlanArtifact, 'basePlanHash' | 'planHash'>,
): unknown {
  return artifact
}

export function createArtifact(
  metadata: Omit<MigrationPlanArtifact, 'basePlanHash' | 'planHash' | 'operations'>,
  operations: readonly MigrationPlanOperation[],
  basePlanHash?: string,
): Effect.Effect<MigrationPlanArtifact, PlanValidationFailure> {
  return Effect.gen(function* () {
    const sortedOperations = sortPlanOperations(operations)
    const withoutHashes = {...metadata, operations: sortedOperations}
    const planHash = canonicalHash(artifactHashInput(withoutHashes))
    const artifact: MigrationPlanArtifact = {
      ...withoutHashes,
      basePlanHash: basePlanHash ?? planHash,
      planHash,
    }
    yield* validateMigrationPlanArtifact(artifact)
    return artifact
  })
}

export function exportMigrationPlan(
  state: CheckpointState,
): Effect.Effect<MigrationPlanArtifact, PlanValidationFailure> {
  return Effect.gen(function* () {
    if (state.phase === 'fetch' || state.phase === 'map') {
      return yield* Effect.fail(
        new PlanValidationFailure({
          message: `Checkpoint ${state.runId} has not completed migration planning.`,
        }),
      )
    }
    if (!state.teamPlan || !state.repositoryGrants) {
      return yield* Effect.fail(
        new PlanValidationFailure({
          message: `Checkpoint ${state.runId} does not contain a materialized migration plan.`,
        }),
      )
    }

    const grants = state.repositoryGrants
    const teamIdBySlug = new Map<string, string>()
    for (const planned of state.teamPlan) {
      teamIdBySlug.set(planned.team.slug, yield* teamOperationId(planned, grants))
    }

    const teamOperations: CreateTeamPlanOperation[] = state.teamPlan.map((planned) => {
      const operationId = teamIdBySlug.get(planned.team.slug)!
      const parentOperationId = planned.parentSlug
        ? teamIdBySlug.get(planned.parentSlug)
        : undefined
      return {
        operationId,
        kind: 'create-team',
        teamKind: planned.kind,
        team: {
          slug: planned.team.slug.normalize('NFC'),
          name: planned.team.name.normalize('NFC'),
          ...(planned.team.description
            ? {description: planned.team.description.normalize('NFC')}
            : {}),
          privacy: planned.team.privacy,
        },
        ...(parentOperationId ? {parentOperationId} : {}),
        sourceAdoTeamIds: [...planned.sourceAdoTeamIds].sort(compareCanonicalText),
        ...(planned.kind === 'repository'
          ? {
              repository: grants.find((grant) => grant.teamSlug === planned.team.slug)!.repository,
            }
          : {}),
      }
    })

    const memberOperations: AssignMemberPlanOperation[] = []
    const memberTargets = new Set<string>()
    for (const mapping of state.mappings) {
      const targetTeamId = teamIdBySlug.get(mapping.githubTeam.slug)
      if (!targetTeamId) {
        return yield* Effect.fail(
          new PlanValidationFailure({
            message: `Mapping for ${mapping.githubTeam.slug} has no planned target team.`,
          }),
        )
      }
      for (const member of mapping.memberMappings) {
        const login = member.githubUser?.login
        if (!member.mapped || !login) {
          continue
        }
        const operationId = memberOperationId(targetTeamId, member.adoIdentity.id)
        const memberTarget = `${targetTeamId}\0${login.toLowerCase()}`
        if (memberTargets.has(memberTarget)) {
          continue
        }
        memberTargets.add(memberTarget)
        memberOperations.push({
          operationId,
          kind: 'assign-member',
          teamOperationId: targetTeamId,
          sourceIdentityId: member.adoIdentity.id.normalize('NFC'),
          login: login.normalize('NFC'),
        })
      }
    }

    const grantOperations: GrantRepositoryPlanOperation[] = []
    for (const grant of grants) {
      const targetTeamId = teamIdBySlug.get(grant.teamSlug)
      if (!targetTeamId) {
        return yield* Effect.fail(
          new PlanValidationFailure({
            message: `Repository grant ${grant.repository} has no planned target team.`,
          }),
        )
      }
      grantOperations.push({
        operationId: grantOperationId(grant.repository),
        kind: 'grant-repository',
        teamOperationId: targetTeamId,
        repository: grant.repository.normalize('NFC'),
        role: grant.role,
        basePermission: grant.basePermission,
        visibility: grant.visibility,
      })
    }

    const snapshot = yield* sourceSnapshot(state)
    return yield* createArtifact(
      {
        artifactVersion: MIGRATION_PLAN_ARTIFACT_VERSION,
        canonicalizationVersion: MIGRATION_PLAN_CANONICALIZATION_VERSION,
        configurationHash: state.configurationHash,
        topologyDigest: state.migrationConfig.topologyDigest ?? '',
        sourceSnapshotHash: canonicalHash(snapshot),
        policy: {
          allowAdmin:
            state.migrationConfig.allowAdmin === true ||
            grants.some((grant) => grant.role === 'admin'),
        },
        sourceSnapshot: snapshot,
      },
      [...teamOperations, ...memberOperations, ...grantOperations],
    )
  })
}

export function validateMigrationPlanArtifact(
  artifact: MigrationPlanArtifact,
): Effect.Effect<void, PlanValidationFailure> {
  return Effect.gen(function* () {
    for (const [label, value] of [
      ['configurationHash', artifact.configurationHash],
      ['sourceSnapshotHash', artifact.sourceSnapshotHash],
      ['basePlanHash', artifact.basePlanHash],
      ['planHash', artifact.planHash],
    ] as const) {
      if (!HASH_PATTERN.test(value)) {
        return yield* Effect.fail(
          new PlanValidationFailure({message: `${label} must be a lowercase SHA-256 hash.`}),
        )
      }
    }
    if (artifact.sourceSnapshotHash !== canonicalHash(artifact.sourceSnapshot)) {
      return yield* Effect.fail(
        new PlanValidationFailure({message: 'Source snapshot hash does not match its content.'}),
      )
    }

    const sorted = sortPlanOperations(artifact.operations)
    const expectedPlanHash = canonicalHash(
      artifactHashInput({
        artifactVersion: artifact.artifactVersion,
        canonicalizationVersion: artifact.canonicalizationVersion,
        configurationHash: artifact.configurationHash,
        topologyDigest: artifact.topologyDigest,
        sourceSnapshotHash: artifact.sourceSnapshotHash,
        policy: artifact.policy,
        sourceSnapshot: artifact.sourceSnapshot,
        operations: sorted,
      }),
    )
    if (artifact.planHash !== expectedPlanHash) {
      return yield* Effect.fail(
        new PlanValidationFailure({message: 'Plan hash does not match artifact content.'}),
      )
    }
    if (canonicalHash(artifact.operations) !== canonicalHash(sorted)) {
      return yield* Effect.fail(
        new PlanValidationFailure({message: 'Plan operations are not in canonical order.'}),
      )
    }

    const byId = new Map<string, MigrationPlanOperation>()
    const teamsBySlug = new Map<string, CreateTeamPlanOperation>()
    const sourceTeamIds = new Set(artifact.sourceSnapshot.teams.map((team) => team.id))
    const sourceMemberships = new Set(
      artifact.sourceSnapshot.memberships.map(
        (membership) => `${membership.teamId}\0${membership.identityId}`,
      ),
    )
    if (
      artifact.sourceSnapshot.memberships.some(
        (membership) => !HASH_PATTERN.test(membership.identityFingerprint),
      )
    ) {
      return yield* Effect.fail(
        new PlanValidationFailure({
          message: 'Source identity fingerprints must be lowercase SHA-256 hashes.',
        }),
      )
    }
    const memberPairs = new Set<string>()
    const grantTargets = new Set<string>()
    for (const operation of artifact.operations) {
      if (byId.has(operation.operationId)) {
        return yield* Effect.fail(
          new PlanValidationFailure({
            message: `Duplicate operation ID ${operation.operationId}.`,
          }),
        )
      }
      byId.set(operation.operationId, operation)
      if (operation.kind === 'create-team') {
        let expectedOperationId: string
        switch (operation.teamKind) {
          case 'organizational-unit':
            expectedOperationId = 'team:organizational-unit:root'
            break
          case 'project':
            expectedOperationId = 'team:project:root'
            break
          case 'flat': {
            const sourceId = operation.sourceAdoTeamIds[0]
            if (operation.sourceAdoTeamIds.length !== 1 || !sourceId) {
              return yield* Effect.fail(
                new PlanValidationFailure({
                  message: `Flat team ${operation.operationId} must reference one source team.`,
                }),
              )
            }
            expectedOperationId = `team:flat:${encodeIdentity(sourceId)}`
            break
          }
          case 'repository':
            if (!operation.repository) {
              return yield* Effect.fail(
                new PlanValidationFailure({
                  message: `Repository team ${operation.operationId} is missing its repository identity.`,
                }),
              )
            }
            expectedOperationId = `team:repository:${encodeIdentity(
              normalizedRepository(operation.repository),
            )}`
            break
        }
        if (operation.operationId !== expectedOperationId) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Team operation ID ${operation.operationId} does not match its semantic identity.`,
            }),
          )
        }
        if (operation.sourceAdoTeamIds.some((sourceId) => !sourceTeamIds.has(sourceId))) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Team ${operation.operationId} references an unknown source ADO team.`,
            }),
          )
        }
        if (!operation.team.slug || !operation.team.name) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Team operation ${operation.operationId} has a blank name or slug.`,
            }),
          )
        }
        if (teamsBySlug.has(operation.team.slug)) {
          return yield* Effect.fail(
            new PlanValidationFailure({message: `Duplicate team slug ${operation.team.slug}.`}),
          )
        }
        teamsBySlug.set(operation.team.slug, operation)
      }
    }

    for (const operation of artifact.operations) {
      if (operation.kind === 'create-team') {
        if (operation.parentOperationId) {
          const parent = byId.get(operation.parentOperationId)
          if (!parent || parent.kind !== 'create-team') {
            return yield* Effect.fail(
              new PlanValidationFailure({
                message: `Team ${operation.operationId} references missing parent ${operation.parentOperationId}.`,
              }),
            )
          }
        }
        continue
      }

      const team = byId.get(operation.teamOperationId)
      if (!team || team.kind !== 'create-team') {
        return yield* Effect.fail(
          new PlanValidationFailure({
            message: `${operation.operationId} references missing team ${operation.teamOperationId}.`,
          }),
        )
      }
      if (operation.kind === 'assign-member') {
        if (
          operation.operationId !==
          memberOperationId(operation.teamOperationId, operation.sourceIdentityId)
        ) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Member operation ID ${operation.operationId} does not match its semantic identity.`,
            }),
          )
        }
        if (!operation.login) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Member operation ${operation.operationId} has a blank login.`,
            }),
          )
        }
        if (
          !team.sourceAdoTeamIds.some((sourceTeamId) =>
            sourceMemberships.has(`${sourceTeamId}\0${operation.sourceIdentityId}`),
          )
        ) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Member ${operation.operationId} is not present in the target team's source snapshot.`,
            }),
          )
        }
        const pair = `${operation.teamOperationId}\0${operation.login.toLowerCase()}`
        if (memberPairs.has(pair)) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Duplicate member assignment ${team.team.slug}:${operation.login}.`,
            }),
          )
        }
        memberPairs.add(pair)
      } else {
        if (operation.operationId !== grantOperationId(operation.repository)) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Grant operation ID ${operation.operationId} does not match its repository.`,
            }),
          )
        }
        if (
          team.teamKind !== 'repository' ||
          normalizedRepository(team.repository ?? '') !== normalizedRepository(operation.repository)
        ) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Grant ${operation.operationId} does not match its repository team.`,
            }),
          )
        }
        const target = normalizedRepository(operation.repository)
        if (grantTargets.has(target)) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Repository ${operation.repository} is granted more than once.`,
            }),
          )
        }
        grantTargets.add(target)
        if (operation.role === 'admin' && !artifact.policy.allowAdmin) {
          return yield* Effect.fail(
            new PlanValidationFailure({
              message: `Admin grant ${operation.operationId} is forbidden by plan policy.`,
            }),
          )
        }
      }
    }

    const visited = new Set<string>()
    const active = new Set<string>()
    const visit = (team: CreateTeamPlanOperation): string | null => {
      if (active.has(team.operationId)) {
        return `Team hierarchy contains a cycle at ${team.operationId}.`
      }
      if (visited.has(team.operationId)) {
        return null
      }
      active.add(team.operationId)
      if (team.parentOperationId) {
        const cycle = visit(byId.get(team.parentOperationId) as CreateTeamPlanOperation)
        if (cycle) {
          return cycle
        }
      }
      active.delete(team.operationId)
      visited.add(team.operationId)
      return null
    }
    for (const team of teamsBySlug.values()) {
      const cycle = visit(team)
      if (cycle) {
        return yield* Effect.fail(new PlanValidationFailure({message: cycle}))
      }
    }
  })
}

export function planOperationMap(
  artifact: MigrationPlanArtifact,
): ReadonlyMap<string, MigrationPlanOperation> {
  return new Map(artifact.operations.map((operation) => [operation.operationId, operation]))
}
