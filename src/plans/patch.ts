import {Effect} from 'effect'
import {createArtifact, planOperationMap, validateMigrationPlanArtifact} from './artifact.js'
import {compareCanonicalText, operationHash} from './canonical.js'
import {PlanCompatibilityFailure, PlanValidationFailure, type PlanFailure} from './errors.js'
import {
  MIGRATION_PLAN_PATCH_VERSION,
  type MigrationPlanArtifact,
  type MigrationPlanPatch,
} from './types.js'

export function assertCompatiblePlans(
  base: MigrationPlanArtifact,
  candidate: MigrationPlanArtifact,
): Effect.Effect<void, PlanCompatibilityFailure> {
  const fields = [
    ['artifact version', base.artifactVersion, candidate.artifactVersion],
    ['canonicalization version', base.canonicalizationVersion, candidate.canonicalizationVersion],
    ['configuration hash', base.configurationHash, candidate.configurationHash],
    ['topology digest', base.topologyDigest, candidate.topologyDigest],
    ['source snapshot hash', base.sourceSnapshotHash, candidate.sourceSnapshotHash],
    ['policy', JSON.stringify(base.policy), JSON.stringify(candidate.policy)],
  ] as const
  const mismatch = fields.find(([, left, right]) => left !== right)
  return mismatch
    ? Effect.fail(
        new PlanCompatibilityFailure({
          message: `Migration plans have different ${mismatch[0]}.`,
        }),
      )
    : Effect.void
}

export function diffMigrationPlans(
  base: MigrationPlanArtifact,
  alternative: MigrationPlanArtifact,
): Effect.Effect<MigrationPlanPatch, PlanFailure> {
  return Effect.gen(function* () {
    yield* validateMigrationPlanArtifact(base)
    yield* validateMigrationPlanArtifact(alternative)
    yield* assertCompatiblePlans(base, alternative)
    const baseOperations = planOperationMap(base)
    const alternativeOperations = planOperationMap(alternative)
    const operationIds = [
      ...new Set([...baseOperations.keys(), ...alternativeOperations.keys()]),
    ].sort(compareCanonicalText)
    const changes = operationIds.flatMap((operationId) => {
      const before = baseOperations.get(operationId)
      const replacement = alternativeOperations.get(operationId)
      return operationHash(before) === operationHash(replacement)
        ? []
        : [
            {
              operationId,
              beforeHash: operationHash(before),
              replacement: replacement ?? null,
            },
          ]
    })
    return {
      patchVersion: MIGRATION_PLAN_PATCH_VERSION,
      canonicalizationVersion: base.canonicalizationVersion,
      basePlanHash: base.planHash,
      changes,
    }
  })
}

export function applyMigrationPlanPatch(
  base: MigrationPlanArtifact,
  patch: MigrationPlanPatch,
): Effect.Effect<MigrationPlanArtifact, PlanFailure> {
  return Effect.gen(function* () {
    yield* validateMigrationPlanArtifact(base)
    if (patch.canonicalizationVersion !== base.canonicalizationVersion) {
      return yield* Effect.fail(
        new PlanCompatibilityFailure({
          message: 'Patch and plan use different canonicalization versions.',
        }),
      )
    }
    if (patch.basePlanHash !== base.planHash) {
      return yield* Effect.fail(
        new PlanCompatibilityFailure({message: 'Patch does not target the supplied base plan.'}),
      )
    }
    const operations = new Map(planOperationMap(base))
    const changedIds = new Set<string>()
    for (const change of patch.changes) {
      if (changedIds.has(change.operationId)) {
        return yield* Effect.fail(
          new PlanValidationFailure({
            message: `Patch changes ${change.operationId} more than once.`,
          }),
        )
      }
      changedIds.add(change.operationId)
      const current = operations.get(change.operationId)
      if (operationHash(current) !== change.beforeHash) {
        return yield* Effect.fail(
          new PlanCompatibilityFailure({
            message: `Patch precondition failed for ${change.operationId}.`,
          }),
        )
      }
      if (change.replacement && change.replacement.operationId !== change.operationId) {
        return yield* Effect.fail(
          new PlanValidationFailure({
            message: `Patch replacement ID does not match ${change.operationId}.`,
          }),
        )
      }
      if (change.replacement) {
        operations.set(change.operationId, change.replacement)
      } else {
        operations.delete(change.operationId)
      }
    }
    return yield* createArtifact(
      {
        artifactVersion: base.artifactVersion,
        canonicalizationVersion: base.canonicalizationVersion,
        configurationHash: base.configurationHash,
        topologyDigest: base.topologyDigest,
        sourceSnapshotHash: base.sourceSnapshotHash,
        policy: base.policy,
        sourceSnapshot: base.sourceSnapshot,
      },
      [...operations.values()],
      base.basePlanHash,
    )
  })
}
