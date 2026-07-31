// Live Node adapter for the write-ahead persona bus. Owns all Node capabilities the domain
// module does not: `node:crypto` (`randomUUID` for run-id minting via `RunIdentityLive`) and
// `node:fs/promises` (filesystem sink + resume file decoding). Everything else — schemas, tagged
// errors, sequencing, redaction — lives in `./agent-bus.ts`.
//
// This mirrors the existing domain/adapter split used elsewhere in this repo: `CheckpointStoreTag`
// (`src/effect/services.ts`) is the domain interface, `CheckpointManager` (`src/checkpoints/
// manager.ts`) is the Node-backed implementation, and `makeCheckpointLayer` (`src/effect/
// layers.ts`) wires the two together. `makeAgentBusLiveLayer` here plays the same role for
// `AgentBusTag`.

import {randomUUID} from 'node:crypto'
import {appendFile, mkdir, readFile, stat} from 'node:fs/promises'
import path from 'node:path'
import {Effect, Either, Layer, Schema} from 'effect'
import {
  AGENT_BUS_PROTOCOL_VERSION,
  AgentBusTag,
  AgentBusWriteFailure,
  ResumeDecodeFailure,
  ResumeReadFailure,
  RunIdentityTag,
  WireEnvelopeSchema,
  makeAgentBusFromSink,
  makeEmptyStore,
  redactIntentEvent,
  redactOutcomeEvent,
  validatePathSafety,
  type AgentBusFailure,
  type AgentBusService,
  type AgentBusSkill,
  type BusStore,
  type CoreEventSink,
  type IntentEvent,
  type OutcomeEvent,
  type PathUnsafeIdentifierFailure,
} from './agent-bus.js'

// ---------------------------------------------------------------------------------------------
// Filesystem capability indirection — the resume/write code paths call `_fsOps.<name>` instead
// of the imported binding directly so tests can substitute failing implementations via
// `vi.spyOn(_fsOps, 'stat')` without needing to mock the entire `node:fs/promises` module.
// This is a test seam ONLY — production callers should never mutate `_fsOps`.
// ---------------------------------------------------------------------------------------------

/** @internal — filesystem indirection for test-seam spies. Do not use outside this module. */
export const _fsOps = {
  appendFile,
  mkdir,
  readFile,
  stat,
}

// ---------------------------------------------------------------------------------------------
// RunIdentityLive — THE only place in the codebase that calls Node's UUID minting primitive.
// ---------------------------------------------------------------------------------------------

/**
 * Live `RunIdentity` capability. This is the ONLY place in the codebase that calls
 * Node UUID minting primitive; the domain module and every non-adapter caller obtain a run id
 * via the
 * `RunIdentityTag` service so tests can substitute a deterministic implementation. Enforces the
 * repo-wide invariant that SDK/filesystem/clock/random capabilities are Layers, not direct
 * imports from domain code.
 */
export const RunIdentityLive: Layer.Layer<RunIdentityTag> = Layer.succeed(RunIdentityTag, {
  generate: Effect.sync(() => randomUUID()),
})

// ---------------------------------------------------------------------------------------------
// Live options + resume decoding
// ---------------------------------------------------------------------------------------------

export interface AgentBusLiveOptions {
  /**
   * Explicit run id. If omitted, one is minted via `RunIdentityTag.generate` so that a fresh
   * run never collides with any previous run's on-disk state.
   */
  readonly runId?: string
  /**
   * Optional runId of a prior run to resume. When supplied, the existing `{baseDir}/{skill}/
   * {personaId}/{runId}.jsonl` file for every persona directory under `{baseDir}/{skill}/` is
   * decoded and used to seed the in-memory correlation index — so replaying already-resolved
   * correlationIds fails with `DuplicateWithinRunFailure` instead of silently double-appending.
   * Torn, version-mismatched, duplicate, or out-of-order lines produce a typed
   * `ResumeDecodeFailure`; a non-ENOENT filesystem error surfaces `ResumeReadFailure`.
   *
   * NOTE: `resumeFromRunId` implies `runId = resumeFromRunId`. Passing both is a programmer error
   * and the two must agree — if they don't, the resume value wins.
   */
  readonly resumeFromRunId?: string
  /** Optional list of `${skill}/${personaId}` combinations to preload during resume. */
  readonly resumeScopes?: ReadonlyArray<{
    readonly skill: AgentBusSkill
    readonly personaId: string
  }>
}

interface NodeSystemError extends Error {
  readonly code?: string
}

function nodeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as NodeSystemError).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'UNKNOWN'
}

/**
 * Distinguish "file genuinely absent" (ENOENT — proceed with an empty resume state) from every
 * other filesystem error (permission denied, I/O failure, etc. — surface as a typed
 * `ResumeReadFailure`). Deliberately does NOT embed the raw underlying error message — a
 * malformed path or leaked payload fragment must not travel up through the failure channel.
 */
async function fileExistsStrict(
  file: string,
): Promise<{present: true} | {present: false} | {error: string}> {
  try {
    const info = await _fsOps.stat(file)
    return info.isFile() ? {present: true} : {present: false}
  } catch (error) {
    const code = nodeErrorCode(error)
    if (code === 'ENOENT') return {present: false}
    return {error: code}
  }
}

interface ReplayIndexEntry {
  hasIntent: boolean
  hasOutcome: boolean
  intent?: IntentEvent
  outcome?: OutcomeEvent
}

/**
 * Decode a single JSONL file for resume. Detects every duplicate/out-of-order sequence variant
 * with a typed reason and a 1-based line number, and NEVER silently overwrites an entry in the
 * correlation index. On success returns the seeded correlation state; on any decode/replay
 * violation returns a `ResumeDecodeFailure`; on a non-ENOENT filesystem error returns a
 * `ResumeReadFailure`. Genuinely-missing files are treated as an empty seed (no failure).
 */
async function decodeResumeFile(
  file: string,
  runId: string,
  correlations: Map<string, ReplayIndexEntry>,
): Promise<ResumeDecodeFailure | ResumeReadFailure | null> {
  const existence = await fileExistsStrict(file)
  if ('error' in existence) {
    return new ResumeReadFailure({
      runId,
      errorCode: existence.error,
      message: `Resume-time filesystem read failed (${existence.error}) — refusing to treat as absent`,
    })
  }
  if (!existence.present) return null
  let contents: string
  try {
    contents = await _fsOps.readFile(file, 'utf8')
  } catch (error) {
    const code = nodeErrorCode(error)
    if (code === 'ENOENT') return null
    return new ResumeReadFailure({
      runId,
      errorCode: code,
      message: `Resume-time read of prior run file failed (${code}) — refusing to treat as absent`,
    })
  }
  const lines = contents.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || line.length === 0) continue
    const lineNumber = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return new ResumeDecodeFailure({
        runId,
        lineNumber,
        reason: 'invalid-json',
        message: `Line ${lineNumber} is not valid JSON [reason=invalid-json, lineNumber=${lineNumber}]`,
      })
    }
    // Check protocol version BEFORE the full schema decode so a mismatch produces the specific
    // reason rather than the generic `schema-mismatch` fallback.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'protocolVersion' in parsed &&
      (parsed as Record<string, unknown>).protocolVersion !== AGENT_BUS_PROTOCOL_VERSION
    ) {
      return new ResumeDecodeFailure({
        runId,
        lineNumber,
        reason: 'protocol-version-mismatch',
        message: `Line ${lineNumber} has protocolVersion=${String(
          (parsed as Record<string, unknown>).protocolVersion,
        )} — bus supports ${AGENT_BUS_PROTOCOL_VERSION} [reason=protocol-version-mismatch, lineNumber=${lineNumber}]`,
      })
    }
    const decoded = Schema.decodeUnknownEither(WireEnvelopeSchema, {onExcessProperty: 'error'})(
      parsed,
    )
    if (Either.isLeft(decoded)) {
      return new ResumeDecodeFailure({
        runId,
        lineNumber,
        reason: 'schema-mismatch',
        message: `Line ${lineNumber} failed schema decode: ${decoded.left.message} [reason=schema-mismatch, lineNumber=${lineNumber}]`,
      })
    }
    const envelope = decoded.right
    const existing = correlations.get(envelope.correlationId) ?? {
      hasIntent: false,
      hasOutcome: false,
    }
    if (envelope.kind === 'intent') {
      if (existing.hasIntent) {
        // Fail closed on a duplicate intent — do NOT overwrite the existing index entry.
        return new ResumeDecodeFailure({
          runId,
          lineNumber,
          reason: 'duplicate-intent',
          message: `Line ${lineNumber} is a second intent for correlationId=${envelope.correlationId} [reason=duplicate-intent, lineNumber=${lineNumber}]`,
        })
      }
      const intentEvent: IntentEvent = {
        runId: envelope.runId,
        correlationId: envelope.correlationId,
        personaId: envelope.personaId,
        domain: envelope.domain,
        skill: envelope.skill,
        iteration: envelope.iteration,
        perceivedInterface: envelope.perceivedInterface,
        intendedAction: envelope.intendedAction,
        expectedResult: envelope.expectedResult,
        protocolVersion: envelope.protocolVersion,
        recordedAt: envelope.recordedAt,
      }
      existing.hasIntent = true
      existing.intent = intentEvent
      correlations.set(envelope.correlationId, existing)
    } else {
      if (!existing.hasIntent) {
        return new ResumeDecodeFailure({
          runId,
          lineNumber,
          reason: 'outcome-before-intent',
          message: `Line ${lineNumber} is an outcome without a preceding intent for correlationId=${envelope.correlationId} [reason=outcome-before-intent, lineNumber=${lineNumber}]`,
        })
      }
      if (existing.hasOutcome) {
        return new ResumeDecodeFailure({
          runId,
          lineNumber,
          reason: 'duplicate-outcome',
          message: `Line ${lineNumber} is a second outcome for correlationId=${envelope.correlationId} [reason=duplicate-outcome, lineNumber=${lineNumber}]`,
        })
      }
      const outcomeEvent: OutcomeEvent = {
        runId: envelope.runId,
        correlationId: envelope.correlationId,
        actualResult: envelope.actualResult,
        delta: envelope.delta,
        desirability: envelope.desirability,
        degree: envelope.degree,
        observedFriction: envelope.observedFriction,
        protocolVersion: envelope.protocolVersion,
        recordedAt: envelope.recordedAt,
      }
      existing.hasOutcome = true
      existing.outcome = outcomeEvent
      correlations.set(envelope.correlationId, existing)
    }
  }
  return null
}

async function readResumedStore(
  baseDir: string,
  runId: string,
  scopes: ReadonlyArray<{readonly skill: AgentBusSkill; readonly personaId: string}>,
): Promise<BusStore | ResumeDecodeFailure | ResumeReadFailure> {
  const correlations = new Map<string, ReplayIndexEntry>()
  for (const scope of scopes) {
    const file = path.join(baseDir, scope.skill, scope.personaId, `${runId}.jsonl`)
    const failure = await decodeResumeFile(file, runId, correlations)
    if (failure !== null) return failure
  }
  const finalStore = new Map<
    string,
    {readonly intent: IntentEvent; readonly outcome: OutcomeEvent | null}
  >()
  for (const [correlationId, entry] of correlations.entries()) {
    if (!entry.intent) continue
    finalStore.set(correlationId, {intent: entry.intent, outcome: entry.outcome ?? null})
  }
  return {correlations: finalStore}
}

// ---------------------------------------------------------------------------------------------
// Live service
// ---------------------------------------------------------------------------------------------

/**
 * Live service. Appends redacted JSONL lines to
 * `${baseDir}/${skill}/${personaId}/${runId}.jsonl`. Writes are serialized by a per-service
 * semaphore so concurrent `Effect.all` calls cannot interleave partial lines. Directory creation
 * is idempotent.
 *
 * `runId` isolates every fresh invocation of the bus from any prior on-disk state: the FRESH run
 * writes to a NEW file whose name comes from `RunIdentityTag.generate`, so a re-run of the CLI
 * never accidentally re-appends to a previous run's log. `resumeFromRunId` opts into rejoining a
 * prior run's file and rejects duplicates within that run.
 *
 * `runId` and `resumeFromRunId` — when provided — are validated against the same defensive
 * charset check applied to `personaId`, BEFORE any `stat`/`mkdir`/`path.join` call. A pathological
 * value (`../..`, null byte, empty, too long) fails with `PathUnsafeIdentifierFailure` and never
 * touches disk.
 */
export function makeAgentBusLiveService(
  baseDir: string = 'reports/agent-bus',
  options: AgentBusLiveOptions = {},
): Effect.Effect<
  AgentBusService,
  AgentBusWriteFailure | ResumeDecodeFailure | ResumeReadFailure | PathUnsafeIdentifierFailure,
  RunIdentityTag
> {
  return Effect.gen(function* () {
    // Validate caller-supplied identifiers BEFORE any filesystem access. This is defence in
    // depth: even if a malicious caller supplied a traversal-shaped value, no path is joined.
    if (options.runId !== undefined) {
      const check = validatePathSafety('runId', options.runId)
      if (Either.isLeft(check)) {
        return yield* Effect.fail<PathUnsafeIdentifierFailure>(check.left)
      }
    }
    if (options.resumeFromRunId !== undefined) {
      const check = validatePathSafety('resumeFromRunId', options.resumeFromRunId)
      if (Either.isLeft(check)) {
        return yield* Effect.fail<PathUnsafeIdentifierFailure>(check.left)
      }
    }
    const identity = yield* RunIdentityTag
    // The domain module never calls randomUUID — the runId is materialised here via the
    // RunIdentity capability service. `RunIdentityLive` is the only implementation that calls
    // `crypto.randomUUID`; tests can substitute a deterministic implementation.
    const runId = options.resumeFromRunId ?? options.runId ?? (yield* identity.generate)
    // The materialised runId itself must also satisfy path-safety — a caller-provided
    // RunIdentityTag can return arbitrary text.
    const runIdCheck = validatePathSafety('runId', runId)
    if (Either.isLeft(runIdCheck)) {
      return yield* Effect.fail<PathUnsafeIdentifierFailure>(runIdCheck.left)
    }
    let initialStore: BusStore = makeEmptyStore()
    if (options.resumeFromRunId !== undefined) {
      const scopes = options.resumeScopes ?? []
      // Validate each scope's personaId BEFORE any filesystem access.
      for (const scope of scopes) {
        const scopeCheck = validatePathSafety('personaId', scope.personaId)
        if (Either.isLeft(scopeCheck)) {
          return yield* Effect.fail<PathUnsafeIdentifierFailure>(scopeCheck.left)
        }
      }
      const resumed = yield* Effect.promise(() =>
        readResumedStore(baseDir, options.resumeFromRunId!, scopes),
      )
      if (resumed instanceof ResumeDecodeFailure) {
        return yield* Effect.fail<ResumeDecodeFailure>(resumed)
      }
      if (resumed instanceof ResumeReadFailure) {
        return yield* Effect.fail<ResumeReadFailure>(resumed)
      }
      initialStore = resumed
    }
    // A single mutex-style semaphore serializes all appends across the process, guaranteeing that
    // two concurrent iterations cannot produce a torn JSONL line.
    const writeMutex = yield* Effect.makeSemaphore(1)

    const writeLine = (
      skill: AgentBusSkill,
      personaId: string,
      line: string,
    ): Effect.Effect<void, AgentBusWriteFailure> =>
      writeMutex.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const dir = path.join(baseDir, skill, personaId)
            await _fsOps.mkdir(dir, {recursive: true})
            const file = path.join(dir, `${runId}.jsonl`)
            await _fsOps.appendFile(file, `${line}\n`, 'utf8')
          },
          catch: (error) =>
            new AgentBusWriteFailure({
              message: `Failed to append agent-bus event: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
        }),
      )

    const sink: CoreEventSink = {
      onIntent: (event) => {
        const redacted = redactIntentEvent(event)
        const payload = JSON.stringify({kind: 'intent', ...redacted})
        return writeLine(redacted.skill, redacted.personaId, payload)
      },
      onOutcome: (event, intent) => {
        // Route the outcome to the same file as its matching intent. The core bus guarantees
        // (via IntentMissingFailure) that we never reach this call without a recorded intent, so
        // `intent.skill` and `intent.personaId` are always the authoritative routing hints.
        const redacted = redactOutcomeEvent(event)
        const payload = JSON.stringify({kind: 'outcome', ...redacted})
        return writeLine(intent.skill, intent.personaId, payload)
      },
    }

    return yield* makeAgentBusFromSink(sink, {
      runId,
      initialStore,
      ...(options.resumeFromRunId !== undefined ? {resumeRunId: options.resumeFromRunId} : {}),
    })
  })
}

/**
 * Live Layer for `AgentBusTag`, self-contained: provides `RunIdentityLive` internally so
 * production callers don't need to know the tag exists. Tests that want a deterministic run id
 * can compose their own layer via `makeDeterministicRunIdentityLayer(...)` and provide it
 * alongside `makeAgentBusLiveService(...)`.
 */
export function makeAgentBusLiveLayer(
  baseDir: string = 'reports/agent-bus',
  options: AgentBusLiveOptions = {},
): Layer.Layer<
  AgentBusTag,
  AgentBusWriteFailure | ResumeDecodeFailure | ResumeReadFailure | PathUnsafeIdentifierFailure
> {
  const raw: Layer.Layer<
    AgentBusTag,
    AgentBusWriteFailure | ResumeDecodeFailure | ResumeReadFailure | PathUnsafeIdentifierFailure,
    RunIdentityTag
  > = Layer.effect(AgentBusTag, makeAgentBusLiveService(baseDir, options))
  return Layer.provide(raw, RunIdentityLive)
}

// Re-export a narrow set of live-adapter failure types so scripts and CLI drivers don't need to
// know both module paths. Domain-level types are re-exported through their original names.
export type LiveOnlyAgentBusFailure = AgentBusFailure
