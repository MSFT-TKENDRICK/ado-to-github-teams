import {Effect} from 'effect'
import {createArtifact, planOperationMap, validateMigrationPlanArtifact} from './artifact.js'
import {compareCanonicalText, operationHash} from './canonical.js'
import {PlanCompatibilityFailure, type PlanFailure} from './errors.js'
import {assertCompatiblePlans} from './patch.js'
import {
  MIGRATION_PLAN_CONFLICT_VERSION,
  type MigrationPlanArtifact,
  type MigrationPlanConflict,
  type MigrationPlanConflictDocument,
  type MigrationPlanMergeResult,
  type MigrationPlanOperation,
} from './types.js'

function conflictKind(
  base: MigrationPlanOperation | undefined,
  left: MigrationPlanOperation | undefined,
  right: MigrationPlanOperation | undefined,
): MigrationPlanConflict['kind'] {
  if (!base) {
    return 'add-add'
  }
  if (!left || !right) {
    return 'delete-modify'
  }
  return 'modify-modify'
}

function sameConflictIdentity(
  expected: MigrationPlanConflict,
  supplied: MigrationPlanConflict,
): boolean {
  return (
    expected.operationId === supplied.operationId &&
    expected.kind === supplied.kind &&
    expected.baseHash === supplied.baseHash &&
    expected.leftHash === supplied.leftHash &&
    expected.rightHash === supplied.rightHash
  )
}

export function mergeMigrationPlans(
  base: MigrationPlanArtifact,
  left: MigrationPlanArtifact,
  right: MigrationPlanArtifact,
  resolutions?: MigrationPlanConflictDocument,
): Effect.Effect<MigrationPlanMergeResult, PlanFailure> {
  return Effect.gen(function* () {
    yield* validateMigrationPlanArtifact(base)
    yield* validateMigrationPlanArtifact(left)
    yield* validateMigrationPlanArtifact(right)
    yield* assertCompatiblePlans(base, left)
    yield* assertCompatiblePlans(base, right)
    for (const alternative of [left, right]) {
      if (
        alternative.basePlanHash !== alternative.planHash &&
        alternative.basePlanHash !== base.planHash &&
        alternative.basePlanHash !== base.basePlanHash
      ) {
        return yield* Effect.fail(
          new PlanCompatibilityFailure({
            message: `Alternative ${alternative.planHash} was derived from a different base plan.`,
          }),
        )
      }
    }

    const baseOperations = planOperationMap(base)
    const leftOperations = planOperationMap(left)
    const rightOperations = planOperationMap(right)
    const operationIds = [
      ...new Set([...baseOperations.keys(), ...leftOperations.keys(), ...rightOperations.keys()]),
    ].sort(compareCanonicalText)
    const merged = new Map<string, MigrationPlanOperation>()
    const conflicts: MigrationPlanConflict[] = []

    for (const operationId of operationIds) {
      const baseOperation = baseOperations.get(operationId)
      const leftOperation = leftOperations.get(operationId)
      const rightOperation = rightOperations.get(operationId)
      const baseHash = operationHash(baseOperation)
      const leftHash = operationHash(leftOperation)
      const rightHash = operationHash(rightOperation)
      let selected: MigrationPlanOperation | undefined
      if (leftHash === rightHash) {
        selected = leftOperation
      } else if (leftHash === baseHash) {
        selected = rightOperation
      } else if (rightHash === baseHash) {
        selected = leftOperation
      } else {
        conflicts.push({
          operationId,
          kind: conflictKind(baseOperation, leftOperation, rightOperation),
          baseHash,
          leftHash,
          rightHash,
          ...(baseOperation ? {base: baseOperation} : {}),
          ...(leftOperation ? {left: leftOperation} : {}),
          ...(rightOperation ? {right: rightOperation} : {}),
        })
        continue
      }
      if (selected) {
        merged.set(operationId, selected)
      }
    }

    const document: MigrationPlanConflictDocument = {
      conflictVersion: MIGRATION_PLAN_CONFLICT_VERSION,
      canonicalizationVersion: base.canonicalizationVersion,
      basePlanHash: base.planHash,
      leftPlanHash: left.planHash,
      rightPlanHash: right.planHash,
      conflicts,
    }
    if (conflicts.length > 0) {
      if (!resolutions) {
        return {_tag: 'Conflicted', document}
      }
      if (
        resolutions.basePlanHash !== document.basePlanHash ||
        resolutions.leftPlanHash !== document.leftPlanHash ||
        resolutions.rightPlanHash !== document.rightPlanHash ||
        resolutions.canonicalizationVersion !== document.canonicalizationVersion
      ) {
        return yield* Effect.fail(
          new PlanCompatibilityFailure({
            message: 'Conflict resolutions target different migration plan inputs.',
          }),
        )
      }
      const suppliedById = new Map(
        resolutions.conflicts.map((conflict) => [conflict.operationId, conflict]),
      )
      for (const conflict of conflicts) {
        const supplied = suppliedById.get(conflict.operationId)
        if (!supplied || !sameConflictIdentity(conflict, supplied) || !supplied.resolution) {
          return {_tag: 'Conflicted', document}
        }
        const selected =
          supplied.resolution === 'left'
            ? leftOperations.get(conflict.operationId)
            : rightOperations.get(conflict.operationId)
        if (selected) {
          merged.set(conflict.operationId, selected)
        }
      }
    }

    const artifact = yield* createArtifact(
      {
        artifactVersion: base.artifactVersion,
        canonicalizationVersion: base.canonicalizationVersion,
        configurationHash: base.configurationHash,
        topologyDigest: base.topologyDigest,
        sourceSnapshotHash: base.sourceSnapshotHash,
        policy: base.policy,
        sourceSnapshot: base.sourceSnapshot,
      },
      [...merged.values()],
      base.basePlanHash,
    )
    return {_tag: 'Merged', artifact}
  })
}
