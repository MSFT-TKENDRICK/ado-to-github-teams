# Agent operating policy

This policy applies to the entire repository. It is mandatory for human-directed and autonomous
agents.

## Worktree isolation

1. Use a dedicated Git worktree and task branch for every agent session on Windows, Linux, or macOS.
   When the host application provides an app-owned worktree, work only in that worktree; do not
   create a nested worktree or read from or write to the main checkout.
2. For sessions created outside the host application, create the workspace with
   `git worktree add -b <task-branch> <worktree-path> <base-ref>` and run all task commands from
   that path. Never share a worktree or branch between active agents.
3. Use one app session, one branch, and one app-native pull request per task. Do not work directly
   in the source checkout or reuse a branch from another task.
4. Before editing, fetch the intended base and verify its commit SHA. Never mutate a source branch
   used as an input to split or stacked work.

## Git and stacked pull requests

1. Make incremental conventional commits after coherent changes. Every commit must end with:

   `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`

2. Run the smallest relevant validation after each logical commit and the full `pnpm check` gate
   before pushing. Never bypass Lefthook, commit with hooks disabled, force-push over reviewed work,
   or weaken a check to make a branch pass.
3. For a stack, create app-native GitHub pull requests from bottom to top. Point each pull request
   at its immediate predecessor, confirm every base/head pair, and only then register the chain
   through the GitHub Stacks REST API. Do not use third-party stack extensions.
4. Squash-merge only when required checks pass and review approvals are current. Merge from the
   bottom upward, revalidate descendants after base changes, and stop on stale or failing checks.
5. After merge or abandonment, remove only worktrees owned by the completed session. Never remove
   the current worktree from inside itself or remove another active agent's worktree.

## Architecture rules

1. Model domain and orchestration behavior with Effect. External capabilities are `Context.Tag`
   services, live and test implementations are Layers, input and persisted data are decoded with
   Schemas, and expected failures are typed tagged errors.
2. Keep domain code independent of SDKs, filesystems, processes, clocks, randomness, and network
   clients. Adapters translate external errors into domain failures at the boundary.
3. Destructive operations are opt-in and must satisfy all invariants:
   - dry-run is the default;
   - the exact proposed change is presented before approval;
   - approval is recorded before the first write;
   - a validated checkpoint is persisted before and after each resumable unit;
   - cancellation and failure flush checkpoint state;
   - resume rejects incompatible configuration or schema versions.
4. Writes must be idempotent. Reads and writes use explicit bounded concurrency, respect service
   throttling, and classify retryable failures. Retries have finite budgets and never repeat an
   unverified destructive operation.
5. Never commit credentials, tokens, tenant data, local configuration, generated reports,
   checkpoints, dependency trees, build output, coverage, or generated PACT artifacts. Reviewed,
   synthetic TUI screenshots and animations under `test/bdd/features/evidence/` are the only
   generated visual exception and must contain no tenant or secret data.
6. Declare application environment variables in `.env.schema`, mark credentials `@sensitive`, and
   use Varlock for validation, injection, audit, and leak scanning. Prefer ambient, federated, or
   managed identities over passwords, PATs, and client secrets.
7. Do not add stubs, placeholder implementations, TODO markers, untyped `any`, broad error catches,
   silent fallbacks, or success-shaped failure paths. Add a package only when it contains working
   code with a defined boundary and tests.

## Squad configuration

1. `squad.config.ts` is the SDK-first source of truth. Run `pnpm squad:build` after changing the
   roster, routing, ceremonies, hooks, telemetry, or Squad skills; never hand-edit generated Squad
   definitions.
2. `src/experience/personas.ts` is the shared source for the eleven research personas (ten CLI operators and one repository contributor) used by both the
   experiment harness and Squad. Keep the generated roster and deterministic drift test aligned.
3. Commit only static Squad configuration and generated definitions. Never commit mutable decisions,
   histories, memory, logs, sessions, telemetry output, or state containing credentials, tenant
   identifiers, personal data, reports, or checkpoints.
4. Squad hooks are development-time defense in depth. They never replace Effect service boundaries,
   application approval, checkpoint, idempotency, bounded-concurrency, or retry enforcement.
5. Run `pnpm squad:bootstrap` after a fresh clone to create ignored local decisions and casting state
   without invoking the Squad CLI's worktree-sharing heuristic.
6. Developer-experience review is isolated: only the `cli-contributor-engineer` persona (Theo)
   assesses DevEx quality, journeys, friction, and evidence acceptance. Operator personas, Fact
   Checker, Scribe, and other agents may perform mechanical implementation or security/privacy
   checks on DevEx changes, but their assessments are not DevEx review evidence. The operator
   persona experiment and its ten operator personas are a separate, non-overlapping evidence loop
   from the DevEx evidence loop (`DEVEX_JOURNEYS` + `src/experience/dev-experience.ts`).

## Write-ahead persona protocol

1. Every persona observation — operator or contributor — must be recorded through the shared
   write-ahead bus at `src/experience/agent-bus.ts` (domain: schemas, tagged errors, service
   interfaces, `runWithIntent` orchestration, pure helpers) plus its live Node adapter at
   `src/experience/agent-bus-live.ts` (filesystem sink, resume decoding, `RunIdentityLive`). The
   split mirrors the domain/adapter separation already used for `CheckpointStoreTag`
   (`src/effect/services.ts` + `src/checkpoints/manager.ts` + `makeCheckpointLayer` in
   `src/effect/layers.ts`). The bus is a mandatory `Context.Tag` service (`AgentBusTag`) that any
   experiment or DX measurement path must depend on.
2. Recording is two-phase and ordered:
   - **Intent** — the persona describes what interface it perceives, the action it intends, and
     the result it expects. `recordIntent` MUST be appended and confirmed before any downstream
     measurement runs. On success it returns a branded, non-forgeable `IntentAck` token — the
     brand is a module-scoped `unique symbol` that is not exported, so an external caller cannot
     construct an object literal that satisfies the `IntentAck` type. Only a successful
     `recordIntent` call produces one.
   - **Outcome** — the persona reports the actual result, a delta description, and a bounded
     desirability judgment (`desirable` / `neutral` / `undesirable`) with a `degree` in `[0, 1]`.
     The public API is `recordOutcome(ack, payload)`: the persisted `correlationId` comes from
     the ack — the caller does NOT supply it — so a caller cannot claim an outcome for a
     correlationId it never received an ack for. Each correlationId may be resolved exactly once.
     The outcome payload is decoded with strict schema (`OutcomeInputPayloadSchema`) — any excess
     field (including a legacy `correlationId` alias) is rejected as a typed
     `OutcomePayloadDecodeFailure` rather than silently disregarded.
3. Callers MUST use `AgentBus.runWithIntent(intent, action, toOutcome)` to sequence the two
   phases. Because the action closure receives the branded `IntentAck` returned by
   `recordIntent`, and the brand is unforgeable through the public API, it is structurally
   impossible to run the action before the intent write succeeds. There is no `updateIntent`,
   `patchIntent`, or `deleteIntent` on the service — a persona cannot revise a prediction after
   seeing the outcome. This defends against outcome-bias contamination in persona evidence.
4. `runWithIntent` ATTEMPTS a terminal outcome append for every intent it records — no matter how
   the action terminates. It captures the action's full `Exit` via `Effect.exit`, classifies the
   outcome as `Success`, `TypedFailure`, `Defect`, or `Interrupt` via `Cause` inspection, and
   invokes the CALLER's `toOutcome(exit, ack, intent)` closure for each terminal shape — the bus
   itself does NOT synthesize an outcome payload on the caller's behalf, because only the caller
   has the persona-specific knowledge (sensitivities, predictions, levers) needed to describe
   what actually happened. The four exit shapes must produce four distinguishable payloads, not
   boilerplate. The outcome-append region runs uninterruptibly so an external interrupt of
   `runWithIntent` cannot skip persisting the terminal outcome. `toOutcome` itself is invoked
   through `Effect.try`, so if the CALLER's callback throws it does not silently defeat the
   attempt guarantee: that specific iteration surfaces a typed `OutcomeAuthoringFailure`
   (bounded, value-free — only the original action's exit-tag classification is attached; the
   thrown error's raw text is never embedded) and no outcome record is written for it. When the
   outcome append succeeds, the original action `Exit` is re-surfaced unchanged; when the
   outcome append itself fails, a typed `TerminalOutcomeAppendFailure` is surfaced (never
   swallowed) that wraps the classification of the original action exit for diagnostics. Every
   `IntentAck` carries an in-band `runId` and is validated against the current bus's `runId`
   and against the stored intent's `recordedAt` inside `recordOutcome` — an ack minted by a
   different bus/run, or a stale ack pointed at a since-replaced intent record, surfaces a
   typed `IntentAckMismatchFailure` and never resolves an intent on this bus. This is an
   ATTEMPT guarantee, not an absolute guarantee that a record is never left unresolved: the
   exact wording is:

   `A terminal outcome append is ALWAYS ATTEMPTED for every started action — success, typed failure, unchecked defect, or interruption. If the terminal append itself fails, the failure is surfaced as a typed TerminalOutcomeAppendFailure (never swallowed). This is an attempt guarantee, not an absolute guarantee that a record is never left unresolved. The attempt guarantee covers the action’s own exit; if the caller’s outcome-authoring callback itself throws, that specific iteration surfaces a typed OutcomeAuthoringFailure and no outcome record is written for it. Every externally-surfaced bus failure is bounded and value-free: only tag/class name, field name or path, line number, and reason code are exposed; no raw parsed value, no raw malformed JSON text, and no literal excerpt of a persona payload is ever embedded in a failure.`

5. The persona/domain/skill triple is strictly enforced against `PERSONA_DEFINITIONS`. Operator
   personas (`OPERATOR_PERSONA_IDS`) may only pair with `skill: 'optimize-ux'`; developer
   personas (`DEVELOPER_PERSONA_IDS`) may only pair with `skill: 'optimize-dx'`. Any unknown
   persona id or mispaired triple fails with a typed `PersonaDomainSkillMismatchFailure` BEFORE
   any file path is constructed or any write is attempted. A defensive charset check
   additionally rejects `personaId`, `runId`, and `resumeFromRunId` values that contain path
   separators, `..`, null bytes, are empty, or are unreasonably long — all validated BEFORE any
   `stat`/`mkdir`/`path.join` call.
6. Every live invocation of the bus (a "run") gets ONE `runId` — minted by the `RunIdentityTag`
   Effect capability service (`RunIdentityLive` is the ONLY place in the codebase that calls
   `crypto.randomUUID()`) — for its whole process lifetime. Live output goes to
   `reports/agent-bus/{skill}/{personaId}/{runId}.jsonl`, and every persisted intent/outcome
   event carries its `runId` in-band (in the JSONL payload itself, not only in the file path) so
   a record's owning run is recoverable from its OWN content. Because every fresh run mints a
   new file, a re-run of the CLI never accidentally re-appends to a prior run's log; the command
   stays usable after any number of previous runs. When a caller supplies BOTH a fresh `runId`
   AND a `resumeFromRunId` that disagree, the live layer refuses with a typed
   `ConflictingRunOptionsFailure` BEFORE any `stat`/`mkdir`/`readFile` call — a contradictory
   configuration cannot silently partially execute. Callers who need to resume a specific prior
   run pass `resumeFromRunId` to the live layer; every `resumeScopes` entry is validated against
   the authoritative `PERSONA_DEFINITIONS`/`OPERATOR_PERSONA_IDS`/`DEVELOPER_PERSONA_IDS` matrix
   (with the scope's `domain` derived from `personaId`, never trusted from a caller field) and
   any mismatch surfaces `PersonaDomainSkillMismatchFailure` BEFORE any filesystem access. The
   layer then reads and Schema-decodes every line of that run's file, builds an in-memory
   duplicate-detection index that fails closed on any duplicate, out-of-order, misfiled, or
   matrix-violating variant, and rejects re-recording an already-resolved correlationId within
   that resumed run with `DuplicateWithinRunFailure`. Torn, protocol-version-mismatched,
   duplicate, out-of-order, cross-run, cross-scope, or matrix-invalid lines during resume fail
   with a typed `ResumeDecodeFailure` that identifies the exact line offset and one of nine
   explicit reasons (`invalid-json`, `schema-mismatch`, `protocol-version-mismatch`,
   `duplicate-intent`, `duplicate-outcome`, `outcome-before-intent`, `run-id-mismatch`,
   `scope-mismatch`, `matrix-violation`) — never a silent partial replay. Non-ENOENT filesystem
   errors during resume surface as a typed `ResumeReadFailure` (never swallowed as "no prior
   run"); a genuinely missing file (ENOENT) is treated as a benign empty seed. The `reports/`
   directory is gitignored; nothing under `reports/agent-bus/` is ever committed.
7. `degree` is a pure desirability judgment. The exact anchors are declared in one place — the
   exported `DESIRABILITY_SCALE_DESCRIPTION` constant in `src/experience/agent-bus.ts` — and
   quoted here verbatim; a documentation contract test asserts the two never drift:

   `degree scale: 0.0 = fully undesirable, 0.5 = neutral or mixed, 1.0 = fully desirable. degree is a pure desirability judgment. The delta field describes expected-vs-actual comparison and is conceptually independent from degree.`

   `delta` is a separate field that describes expected-vs-actual comparison. Do not conflate the
   two — a value can be "neutral or mixed" desirability (`degree = 0.5`) while the delta clearly
   describes an observed regression, or vice versa.

8. Redaction is defence-in-depth on top of the "no secrets in intent/outcome" rule. Before
   writing, the live layer replaces LABELED secret-shaped substrings with `[redacted]`: GitHub
   token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), AWS access key ids (`AKIA...`),
   JWT-shaped triples (`eyJ...`), `Bearer ...` values, and labeled `key=value` assignments where
   the key is `pat`, `token`, `secret`, `password`, `pwd`, `apikey`, `api_key`, `accountkey`,
   `sharedaccesskey`, `connectionstring`, `conn_str`, `clientsecret`, or `client_secret` and the
   value is at least 16 credential-shaped characters. The redactor deliberately does NOT match a
   bare 40-character hex string — a legitimate commit SHA quoted in prose is not redacted. No
   credentials, tokens, tenant identifiers, personal data, reports, or checkpoints may be
   embedded in intent or outcome fields in the first place.
9. Domain isolation is preserved by the bus. Every event carries an explicit `domain`
   (`operator` | `developer`) and `skill` (`optimize-ux` | `optimize-dx`) label. Operator persona
   evidence goes only into `optimize-ux` files and never mixes with DevEx evidence. The
   `cli-contributor-engineer` persona (Theo) is the sole judge of DevEx evidence; operator
   personas do not render DX verdicts through the bus or anywhere else.

## Testing and quality gates

1. Unit tests provide deterministic test Layers; they do not call live services.
2. PACT consumer tests use dedicated provider Layers and generate artifacts only during the test
   run. PACT tasks and generated artifacts must never use Turbo caching.
3. Integration tests compose real internal Layers with controlled external boundaries. Destructive
   scenarios assert approval, checkpoint, idempotency, and bounded-concurrency invariants.
4. Every TUI change must update deterministic frame/runtime tests and the adjacent Gherkin scenarios,
   pass focused TUI tests plus `pnpm test:bdd`, and regenerate committed PNG/GIF evidence with
   `pnpm tui:evidence`. Review the refreshed assets for wide, standard, narrow, blocked, failed,
   completed, reduced-motion, and animated states. Embed the relevant committed assets and exact
   validation commands in the pull request body so reviewers do not need to run the application.
5. Run `pnpm secrets:check`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:unit`,
   `pnpm test:contract`, `pnpm test:integration`, and `pnpm package:smoke`. The
   aggregate `pnpm check` command is the required pre-push and pre-merge gate.

## Security and operational safety

Use least-privilege credentials, redact sensitive values from logs and errors, validate every
external payload, and require explicit confirmation for repository, organization, identity, or
membership writes. Stop and escalate when an operation's scope, target, approval state, or rollback
path is ambiguous.
