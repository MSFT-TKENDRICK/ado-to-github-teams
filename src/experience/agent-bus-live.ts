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
  ConflictingRunOptionsFailure,
  PersonaDomainSkillMismatchFailure,
  ResumeDecodeFailure,
  ResumeReadFailure,
  RunIdentityTag,
  WireEnvelopeSchema,
  makeAgentBusFromSink,
  makeEmptyStore,
  redactIntentEvent,
  redactOutcomeEvent,
  validatePathSafety,
  validatePersonaMatrix,
  validateResumeScopeMatrix,
  type AgentBusDomain,
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
   * Torn, version-mismatched, duplicate, out-of-order, misfiled, or matrix-violating lines
   * produce a typed `ResumeDecodeFailure`; a non-ENOENT filesystem error surfaces
   * `ResumeReadFailure`.
   *
   * Item 3: `runId` and `resumeFromRunId` are BOTH validated up-front. If both are supplied and
   * they disagree, the constructor fails with `ConflictingRunOptionsFailure` BEFORE any
   * filesystem access (no `stat`/`mkdir`/`readFile` call is made). If they agree, or only one
   * is supplied, execution proceeds normally.
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
 *
 * Item 2: additionally verifies per-line identity integrity against the resume request:
 *   - `envelope.runId` MUST equal the `runId` being resumed (`run-id-mismatch`).
 *   - `envelope.personaId` and `envelope.skill` MUST equal the scope's persona/skill (a line
 *     for a different scope copied into this file, deliberately or by misfiling, is rejected
 *     with `scope-mismatch`).
 *   - The line's (persona/domain/skill) triple must still satisfy `validatePersonaMatrix`
 *     (`matrix-violation`) — e.g. an operator-domain event mislabelled with `skill: 'optimize-
 *     dx'` is rejected even if the file it lived in was scoped correctly.
 *
 * Item 4: no raw parse-error text, raw line content, or literal payload excerpt is ever
 * embedded in a `ResumeDecodeFailure` — only `reason` + `lineNumber` + the requested `runId`
 * (which is scope metadata, not payload content).
 */
async function decodeResumeFile(
  file: string,
  runId: string,
  scope: {
    readonly skill: AgentBusSkill
    readonly personaId: string
    readonly domain: AgentBusDomain
  },
  correlations: Map<string, ReplayIndexEntry>,
): Promise<ResumeDecodeFailure | ResumeReadFailure | null> {
  const existence = await fileExistsStrict(file)
  if ('error' in existence) {
    return new ResumeReadFailure({runId, errorCode: existence.error})
  }
  if (!existence.present) return null
  let contents: string
  try {
    contents = await _fsOps.readFile(file, 'utf8')
  } catch (error) {
    const code = nodeErrorCode(error)
    if (code === 'ENOENT') return null
    return new ResumeReadFailure({runId, errorCode: code})
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
      return new ResumeDecodeFailure({runId, lineNumber, reason: 'invalid-json'})
    }
    // Check protocol version BEFORE the full schema decode so a mismatch produces the specific
    // reason rather than the generic `schema-mismatch` fallback.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'protocolVersion' in parsed &&
      (parsed as Record<string, unknown>).protocolVersion !== AGENT_BUS_PROTOCOL_VERSION
    ) {
      return new ResumeDecodeFailure({runId, lineNumber, reason: 'protocol-version-mismatch'})
    }
    const decoded = Schema.decodeUnknownEither(WireEnvelopeSchema, {onExcessProperty: 'error'})(
      parsed,
    )
    if (Either.isLeft(decoded)) {
      return new ResumeDecodeFailure({runId, lineNumber, reason: 'schema-mismatch'})
    }
    const envelope = decoded.right
    // Item 2 (run-id): the envelope's in-band runId MUST equal the run being resumed. A line
    // whose runId does not match is either misfiled or minted for a different run — either way
    // it must not be silently absorbed into this run's index.
    if (envelope.runId !== runId) {
      return new ResumeDecodeFailure({runId, lineNumber, reason: 'run-id-mismatch'})
    }
    // Item 2 (scope + matrix): the envelope's persona/skill MUST match the scope/file we are
    // reading. A developer-domain event copied into an optimize-ux operator file (or vice
    // versa) is rejected — one scope's replay cannot be contaminated by another's misfiled
    // event. Intent envelopes carry the persona/domain/skill triple in the wire schema and are
    // matched against the current scope directly here. Outcome envelopes DO NOT carry that
    // triple on the wire, so their scope is enforced below (in the outcome branch) by checking
    // the previously-recorded intent's authoritative triple against the scope currently being
    // decoded — see the outcome-branch cross-scope enforcement. The correlation index is
    // deliberately shared across scopes so cross-scope duplicate-INTENT detection continues to
    // work, but the OUTCOME acceptance path now requires the recorded intent to originate from
    // the same scope as the outcome line.
    if (envelope.kind === 'intent') {
      if (envelope.personaId !== scope.personaId || envelope.skill !== scope.skill) {
        return new ResumeDecodeFailure({runId, lineNumber, reason: 'scope-mismatch'})
      }
      // Item 2 (matrix): even a structurally-decoded line may carry an invalid persona/domain/
      // skill triple (e.g. an unknown persona, or an operator persona mis-tagged with
      // `optimize-dx`). Run the same authoritative matrix check the intent path uses.
      const matrixInput = {
        correlationId: envelope.correlationId,
        personaId: envelope.personaId,
        domain: envelope.domain,
        skill: envelope.skill,
        iteration: envelope.iteration,
        perceivedInterface: '',
        intendedAction: '',
        expectedResult: '',
      }
      const matrixCheck = validatePersonaMatrix(matrixInput)
      if (Either.isLeft(matrixCheck)) {
        return new ResumeDecodeFailure({runId, lineNumber, reason: 'matrix-violation'})
      }
    }
    const existing = correlations.get(envelope.correlationId) ?? {
      hasIntent: false,
      hasOutcome: false,
    }
    if (envelope.kind === 'intent') {
      if (existing.hasIntent) {
        // Fail closed on a duplicate intent — do NOT overwrite the existing index entry.
        return new ResumeDecodeFailure({runId, lineNumber, reason: 'duplicate-intent'})
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
      // Cross-scope outcome contamination guard: an outcome for correlationId `X` misfiled
      // into a different scope's file (a different persona/domain/skill) must NOT be silently
      // absorbed just because a legitimate intent for `X` exists somewhere in the shared
      // correlation index. Compare the previously-recorded intent's authoritative
      // (personaId, skill, domain) — matrix-validated when the intent line itself was decoded
      // above — against the scope currently being decoded (which was matrix-validated in
      // readResumedStore before entry; its `domain` is derived from `personaId`, not trusted
      // from a caller-supplied field in isolation). Fire BEFORE `outcome-before-intent` and
      // `duplicate-outcome` so the rejection is order-independent: whether the misfiled scope
      // is processed first (`outcome-before-intent` also catches it) or second (this check
      // catches it), no misfiled outcome ever slips through. Reuses the existing
      // `scope-mismatch` reason — the acceptance boundary being crossed is the same one the
      // intent-side check protects, and callers already switch on that reason code.
      if (
        existing.hasIntent &&
        existing.intent !== undefined &&
        (existing.intent.personaId !== scope.personaId ||
          existing.intent.skill !== scope.skill ||
          existing.intent.domain !== scope.domain)
      ) {
        return new ResumeDecodeFailure({runId, lineNumber, reason: 'scope-mismatch'})
      }
      if (!existing.hasIntent) {
        return new ResumeDecodeFailure({runId, lineNumber, reason: 'outcome-before-intent'})
      }
      if (existing.hasOutcome) {
        return new ResumeDecodeFailure({runId, lineNumber, reason: 'duplicate-outcome'})
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
  scopes: ReadonlyArray<{
    readonly skill: AgentBusSkill
    readonly personaId: string
    readonly domain: AgentBusDomain
  }>,
): Promise<BusStore | ResumeDecodeFailure | ResumeReadFailure> {
  const correlations = new Map<string, ReplayIndexEntry>()
  for (const scope of scopes) {
    const file = path.join(baseDir, scope.skill, scope.personaId, `${runId}.jsonl`)
    const failure = await decodeResumeFile(file, runId, scope, correlations)
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
  | AgentBusWriteFailure
  | ResumeDecodeFailure
  | ResumeReadFailure
  | PathUnsafeIdentifierFailure
  | ConflictingRunOptionsFailure
  | PersonaDomainSkillMismatchFailure,
  RunIdentityTag
> {
  return Effect.gen(function* () {
    // Item 3: reject a contradictory (runId, resumeFromRunId) pair BEFORE any filesystem
    // access. If a caller supplies both and they disagree, silently letting one win would
    // partially execute against a target the caller did not explicitly authorize. Surface a
    // typed `ConflictingRunOptionsFailure` up-front — this happens before RunIdentityTag is
    // consulted and before any `stat`/`mkdir`/`readFile` call.
    if (
      options.runId !== undefined &&
      options.resumeFromRunId !== undefined &&
      options.runId !== options.resumeFromRunId
    ) {
      return yield* Effect.fail<ConflictingRunOptionsFailure>(
        new ConflictingRunOptionsFailure({
          reason: 'runId-does-not-match-resumeFromRunId',
        }),
      )
    }
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
    // Item 6: validate every resume scope against the authoritative persona/domain/skill
    // matrix BEFORE any filesystem access. Derive the domain from personaId via
    // PERSONA_DEFINITIONS (do not trust a caller-supplied domain field in isolation — the
    // scope shape does not have one, so this is the only path). A mismatch surfaces the
    // same typed failure the intent path uses, and no `stat`/`readFile`/`mkdir` call is made
    // for any scope.
    const validatedScopes: Array<{
      readonly skill: AgentBusSkill
      readonly personaId: string
      readonly domain: AgentBusDomain
    }> = []
    if (options.resumeFromRunId !== undefined) {
      const rawScopes = options.resumeScopes ?? []
      for (const scope of rawScopes) {
        const scopeCheck = validateResumeScopeMatrix(scope)
        if (Either.isLeft(scopeCheck)) {
          return yield* Effect.fail<
            PersonaDomainSkillMismatchFailure | PathUnsafeIdentifierFailure
          >(scopeCheck.left)
        }
        validatedScopes.push(scopeCheck.right)
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
      const resumed = yield* Effect.promise(() =>
        readResumedStore(baseDir, options.resumeFromRunId!, validatedScopes),
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
            // Item 4: bounded, value-free — expose only the Node error code, never a raw
            // path, payload fragment, or upstream exception message.
            new AgentBusWriteFailure({errorCode: nodeErrorCode(error)}),
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
  | AgentBusWriteFailure
  | ResumeDecodeFailure
  | ResumeReadFailure
  | PathUnsafeIdentifierFailure
  | ConflictingRunOptionsFailure
  | PersonaDomainSkillMismatchFailure
> {
  const raw: Layer.Layer<
    AgentBusTag,
    | AgentBusWriteFailure
    | ResumeDecodeFailure
    | ResumeReadFailure
    | PathUnsafeIdentifierFailure
    | ConflictingRunOptionsFailure
    | PersonaDomainSkillMismatchFailure,
    RunIdentityTag
  > = Layer.effect(AgentBusTag, makeAgentBusLiveService(baseDir, options))
  return Layer.provide(raw, RunIdentityLive)
}

// Re-export a narrow set of live-adapter failure types so scripts and CLI drivers don't need to
// know both module paths. Domain-level types are re-exported through their original names.
export type LiveOnlyAgentBusFailure = AgentBusFailure
