import {createHash} from 'node:crypto'
import type {MigrationPlanOperation} from './types.js'

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.normalize('NFC')
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, entry]) => [key.normalize('NFC'), canonicalValue(entry)]),
    )
  }
  return value
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex')
}

export function operationHash(operation: MigrationPlanOperation | undefined): string | null {
  return operation ? canonicalHash(operation) : null
}

function operationRank(operation: MigrationPlanOperation): number {
  switch (operation.kind) {
    case 'create-team':
      return 0
    case 'assign-member':
      return 1
    case 'grant-repository':
      return 2
  }
}

export function sortPlanOperations(
  operations: readonly MigrationPlanOperation[],
): MigrationPlanOperation[] {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]))
  const depths = new Map<string, number>()
  const teamDepth = (operation: MigrationPlanOperation, path = new Set<string>()): number => {
    if (operation.kind !== 'create-team' || !operation.parentOperationId) {
      return 0
    }
    const cached = depths.get(operation.operationId)
    if (cached !== undefined) {
      return cached
    }
    if (path.has(operation.operationId)) {
      return Number.MAX_SAFE_INTEGER
    }
    const parent = byId.get(operation.parentOperationId)
    if (!parent) {
      return Number.MAX_SAFE_INTEGER
    }
    const nextPath = new Set(path).add(operation.operationId)
    const depth = teamDepth(parent, nextPath) + 1
    depths.set(operation.operationId, depth)
    return depth
  }

  return [...operations].sort((left, right) => {
    const rankDifference = operationRank(left) - operationRank(right)
    if (rankDifference !== 0) {
      return rankDifference
    }
    if (left.kind === 'create-team' && right.kind === 'create-team') {
      const depthDifference = teamDepth(left) - teamDepth(right)
      if (depthDifference !== 0) {
        return depthDifference
      }
    }
    return compareCanonicalText(left.operationId, right.operationId)
  })
}
