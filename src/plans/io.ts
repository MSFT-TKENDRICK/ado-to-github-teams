import {randomUUID} from 'node:crypto'
import {link, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {Effect} from 'effect'
import {validateMigrationPlanArtifact} from './artifact.js'
import {PlanDecodeFailure, type PlanFailure} from './errors.js'
import {
  decodeMigrationPlanArtifact,
  decodeMigrationPlanConflictDocument,
  decodeMigrationPlanPatch,
} from './schemas.js'
import type {
  MigrationPlanArtifact,
  MigrationPlanConflictDocument,
  MigrationPlanPatch,
} from './types.js'

export function readJsonFile(filePath: string): Effect.Effect<unknown, PlanDecodeFailure> {
  const resolved = path.resolve(filePath)
  return Effect.tryPromise({
    try: async () => JSON.parse(await readFile(resolved, 'utf8')) as unknown,
    catch: (cause) =>
      new PlanDecodeFailure({
        message: `Unable to read JSON file ${resolved}.`,
        cause,
      }),
  })
}

export function writeJsonFile(
  filePath: string,
  value: unknown,
): Effect.Effect<string, PlanDecodeFailure> {
  const resolved = path.resolve(filePath)
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomUUID()}.tmp`,
  )
  return Effect.tryPromise({
    try: async () => {
      try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        await link(temporary, resolved)
      } catch (cause) {
        await rm(temporary, {force: true})
        throw new PlanDecodeFailure({
          message: `Unable to atomically write ${resolved}; the destination must not already exist.`,
          cause,
        })
      }
      try {
        await rm(temporary)
      } catch (cause) {
        process.emitWarning(
          `Wrote ${resolved}, but could not remove temporary file ${temporary}: ${String(cause)}`,
        )
      }
      return resolved
    },
    catch: (cause) =>
      cause instanceof PlanDecodeFailure
        ? cause
        : new PlanDecodeFailure({message: `Unable to write ${resolved}.`, cause}),
  })
}

export function loadMigrationPlanArtifact(
  filePath: string,
): Effect.Effect<MigrationPlanArtifact, PlanFailure> {
  return Effect.gen(function* () {
    const artifact = yield* readJsonFile(filePath).pipe(Effect.flatMap(decodeMigrationPlanArtifact))
    yield* validateMigrationPlanArtifact(artifact)
    return artifact
  })
}

export function loadMigrationPlanPatch(
  filePath: string,
): Effect.Effect<MigrationPlanPatch, PlanDecodeFailure> {
  return readJsonFile(filePath).pipe(Effect.flatMap(decodeMigrationPlanPatch))
}

export function loadMigrationPlanConflictDocument(
  filePath: string,
): Effect.Effect<MigrationPlanConflictDocument, PlanDecodeFailure> {
  return readJsonFile(filePath).pipe(Effect.flatMap(decodeMigrationPlanConflictDocument))
}
