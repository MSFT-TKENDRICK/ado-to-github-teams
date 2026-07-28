# Agent operating policy

This policy applies to the entire repository. It is mandatory for human-directed and autonomous
agents.

## Fail-closed workspace isolation

1. Work only on Linux x64 with a Rift-supported reflink filesystem or on macOS. Windows has no Rift
   workspace backend. If Rift cannot initialize or create a workspace, stop before reading task
   files, installing dependencies, changing Git state, or editing code.
2. Initialize the checkout with `rift init --here`. Every agent must then create and enter its own
   named workspace with `rift create --name <task-name>`. Confirm isolation with `rift ancestors`.
   Never share a Rift workspace between agents.
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
5. After merge or abandonment, remove the agent's Rift descendants, run `rift gc`, and remove
   completed app worktrees. Never remove another active agent's workspace.

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
   checkpoints, dependency trees, build output, coverage, or generated PACT artifacts.
6. Do not add stubs, placeholder implementations, TODO markers, untyped `any`, broad error catches,
   silent fallbacks, or success-shaped failure paths. Add a package only when it contains working
   code with a defined boundary and tests.

## Testing and quality gates

1. Unit tests provide deterministic test Layers; they do not call live services.
2. PACT consumer tests use dedicated provider Layers and generate artifacts only during the test
   run. PACT tasks and generated artifacts must never use Turbo caching.
3. Integration tests compose real internal Layers with controlled external boundaries. Destructive
   scenarios assert approval, checkpoint, idempotency, and bounded-concurrency invariants.
4. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:unit`,
   `pnpm test:contract`, `pnpm test:integration`, `pnpm test`, and `pnpm package:smoke`. The
   aggregate `pnpm check` command is the required pre-push and pre-merge gate.

## Security and operational safety

Use least-privilege credentials, redact sensitive values from logs and errors, validate every
external payload, and require explicit confirmation for repository, organization, identity, or
membership writes. Stop and escalate when an operation's scope, target, approval state, or rollback
path is ambiguous.
