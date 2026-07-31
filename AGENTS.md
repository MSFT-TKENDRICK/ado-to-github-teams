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
   write-ahead bus at `src/experience/agent-bus.ts`. The bus is a mandatory `Context.Tag` service
   (`AgentBusTag`) that any experiment or DX measurement path must depend on.
2. Recording is two-phase and ordered:
   - **Intent** — the persona describes what interface it perceives, the action it intends, and
     the result it expects. `recordIntent` MUST be appended and confirmed before any downstream
     measurement runs. On success it returns an opaque `IntentAck` token.
   - **Outcome** — the persona reports the actual result, a delta description, and a bounded
     desirability judgment (`desirable` / `neutral` / `undesirable`) with a `degree` in `[0, 1]`.
     `recordOutcome` requires the `correlationId` of a previously recorded intent; each
     correlationId may be resolved exactly once.
3. Callers MUST use `AgentBus.runWithIntent(intent, action, toOutcome)` to sequence the two
   phases. Because the action closure receives the `IntentAck` returned by `recordIntent`, and
   `IntentAck` is only produced when the intent has been appended and confirmed by the sink, it
   is structurally impossible to run the action before the intent write succeeds. There is no
   `updateIntent`, `patchIntent`, or `deleteIntent` on the service — a persona cannot revise a
   prediction after seeing the outcome. This defends against outcome-bias contamination in
   persona evidence.
4. The `degree` scale is anchored: `0.0` = fully undesirable / regression or friction moved the
   wrong way; `0.5` = matches prediction exactly (neutral evidence); `1.0` = fully desirable /
   observed much better than predicted. Ranges between are linear.
5. Live output goes to `reports/agent-bus/{skill}/{personaId}.jsonl`. The `reports/` directory
   is already gitignored; nothing under `reports/agent-bus/` is ever committed. Before writing,
   the live layer redacts secret-shaped substrings (GitHub token prefixes, AWS access key ids,
   Bearer/PAT/apikey assignments, JWT-shaped triples) to `[redacted]`. No credentials, tokens,
   tenant identifiers, personal data, reports, or checkpoints may be embedded in intent or
   outcome fields.
6. Domain isolation is preserved by the bus. Every event carries an explicit `domain`
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
