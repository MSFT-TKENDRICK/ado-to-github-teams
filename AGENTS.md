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
   checkpoints, dependency trees, build output, coverage, or generated PACT artifacts.
6. Declare application environment variables in `.env.schema`, mark credentials `@sensitive`, and
   use Varlock for validation, injection, audit, and leak scanning. Prefer ambient, federated, or
   managed identities over passwords, PATs, and client secrets.
7. Do not add stubs, placeholder implementations, TODO markers, untyped `any`, broad error catches,
   silent fallbacks, or success-shaped failure paths. Add a package only when it contains working
   code with a defined boundary and tests.

## Testing and quality gates

1. Unit tests provide deterministic test Layers; they do not call live services.
2. PACT consumer tests use dedicated provider Layers and generate artifacts only during the test
   run. PACT tasks and generated artifacts must never use Turbo caching.
3. Integration tests compose real internal Layers with controlled external boundaries. Destructive
   scenarios assert approval, checkpoint, idempotency, and bounded-concurrency invariants.
4. Run `pnpm secrets:check`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:unit`,
   `pnpm test:contract`, `pnpm test:integration`, `pnpm test`, and `pnpm package:smoke`. The
   aggregate `pnpm check` command is the required pre-push and pre-merge gate.

## Security and operational safety

Use least-privilege credentials, redact sensitive values from logs and errors, validate every
external payload, and require explicit confirmation for repository, organization, identity, or
membership writes. Stop and escalate when an operation's scope, target, approval state, or rollback
path is ambiguous.
