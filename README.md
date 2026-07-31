# ado-to-github-teams

[![CI](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml/badge.svg)](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`ado-to-github-teams` migrates Azure DevOps project teams and their members to a GitHub
organization. It resolves Microsoft Entra identities to GitHub Enterprise Managed Users, previews
the proposed changes, creates approved teams and memberships, and produces a migration report.

> [!IMPORTANT]
> This project is pre-release. Pin the version you evaluate and test against a non-production
> organization first.

## What it does

- Maps Azure DevOps teams to GitHub organization teams.
- Matches Azure DevOps and Microsoft Entra identities to GitHub users.
- Supports flat team migration or an explicit organization-unit/project/repository team hierarchy.
- Exports content-addressed plans for guarded patches and explicit three-way collaboration.
- Refuses GitHub writes unless `--apply` is provided and the proposed changes are approved.
- Keeps interrupted migrations resumable and records outcomes in a Markdown report.

## Try it safely

Install the CLI from npm, then choose a starting command by task:

```bash
npm install --global @msft-tkendrick/a2g@preview
a2g --help
```

Durable workflows run locally by default. To opt into Azure Durable Functions,
run `a2g world`; Azure is selected only after an Azure sign-in finds an enabled
subscription and you choose it. Tagged prereleases also include an Azure Functions
deployment artifact; no other cloud deployment target is supported.

Or run the bundled sandbox directly:

```bash
a2g --sandbox happy-path
```

The sandbox uses synthetic data and cannot write to Azure DevOps, Microsoft Entra ID, or GitHub.

## Contributor quick start

New to the repository? This is the shortest path from a fresh clone to a running local change.
For the full contributor policy, see [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

### Prerequisites

- Node.js 22.18 or later and earlier than Node.js 26 (Node.js 22 is used in CI).
- pnpm 10.34.5 through Corepack.
- Git 2.31 or later with worktree support.

### Shortest path to a running change

Run these steps in order:

1. `corepack enable`
2. `pnpm install --frozen-lockfile`
3. `pnpm dev -- --sandbox happy-path`

> **Optional — Copilot Squad only.** If you plan to work with the SDK-first Copilot Squad agents,
> also run `pnpm squad:bootstrap` and `pnpm squad:check` after step 2. Neither is required to build,
> test, or use the CLI itself. See [GitHub Copilot Squad](#github-copilot-squad) below.

### Development loop

`pnpm dev` runs the TypeScript CLI directly with `tsx`; no `pnpm build` is required to iterate:

```bash
pnpm dev -- --list-sandbox-scenarios
pnpm dev -- --sandbox happy-path
```

### Validation — focused vs. full

Reach for the smallest command that covers what changed while iterating:

- `pnpm format:check` — Prettier check
- `pnpm lint` — ESLint
- `pnpm typecheck` — TypeScript, no emit
- `pnpm test:unit` — deterministic unit tests

The full pre-push and pre-merge gate is `pnpm check` (adds secrets, squad, build, contract,
integration, and package smoke). See [Testing](docs/testing.md) for the complete command table.

### Debugging & troubleshooting

- **Run a single test file:** `pnpm vitest run test/unit/experience/dev-experience.test.ts`.
- **Suppress the interactive terminal dashboard:** set `NO_TUI=1` (or pass `--no-tui`) for
  stable line-oriented output when diagnosing behavior.
- **Check Squad install health:** `pnpm squad:doctor` reports missing components or version
  drift before Squad-related tasks silently misbehave.
- **`pnpm install --frozen-lockfile` fails on a fresh clone:** the lockfile has drifted from
  `package.json`. Do not hand-edit `pnpm-lock.yaml`; re-run `pnpm install` in an isolated worktree,
  commit the regenerated lockfile, and investigate the dependency change that caused the drift.
- **Environment validation fails:** run `pnpm secrets:check` to validate `.env.schema` and scan
  for plaintext leakage before pushing.

### Architecture / repo map

- `src/` — active migration CLI, Effect services, adapters, TUI, and the shared experience module.
- `test/` — Vitest unit, contract, integration, and Cucumber BDD suites.
- `scripts/` — repository automation entry points (persona experiments, Squad bootstrap, BDD
  runner, TUI evidence).
- `skills/` — Agent Skills for `ado-to-github-teams`, `optimize-ux`, and `optimize-dx`.
- `apps/cli/` — staged package shell for the eventual published CLI. The root/`apps/cli` split
  is a transitional monorepo layout not yet wired into the root `pnpm check` gate; unifying it is
  out of scope for this pass.
- `sandbox/` — synthetic scenario catalog for `--sandbox` runs.

See [Architecture](docs/architecture.md) for boundaries, safety model, and topology.

### Contribution & agent guidance

- [CONTRIBUTING.md](CONTRIBUTING.md) — full contributor policy, common commands table, hook
  enforcement, and validation gates.
- [AGENTS.md](AGENTS.md) — non-negotiable engineering policy for human and autonomous agents.
- [`skills/optimize-dx/SKILL.md`](skills/optimize-dx/SKILL.md) — qualitatively critique the
  repository developer experience against nine pain categories, implement one bounded
  surface change, and refresh the affected contributor documentation. Rotate the runner
  across the area catalog with `pnpm optimize:dx` (defaults to 8 iterations) or, for a
  narrower pass, `pnpm optimize:dx -- --iterations 3` (any integer from 1 through 20).

## Migrate teams

1. [Start the worker and authenticate](docs/using-the-cli.md#prepare-a-live-migration).
2. Generate a dry-run report:

   ```bash
   a2g migrate --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso --foreground
   ```

   The equivalent task-shaped scope aliases are `--source-org`, `--source-project`, and
   `--target-org`. Use `migrate --help` to see scope, execution, recovery, presentation, topology,
   worker, and sandbox flags in separate groups.

3. Review every proposed team, membership, skipped identity, and warning in the report.
4. Run the same command with `--apply`, then approve the exact changes shown by the CLI:

   ```bash
   a2g migrate --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso --apply --foreground
   ```

Dry run is always the default. Reports and migration state can contain organization and identity
data; keep them private.

## Interactive terminal dashboard

Interactive sandbox runs and `migrate --foreground` use a responsive full-screen terminal dashboard
when stdout is a TTY. It presents the safety mode, scope, run ID, current and queued stages, elapsed
time, live activity, and next event in one stable frame. The renderer caps animation at 12 frames per
second, redraws atomically in the terminal's alternate screen, and recomposes after resize without
leaving partial or stale lines.

Use `--no-tui` or `NO_TUI=1` for stable line-oriented output. `REDUCE_MOTION=1` keeps the dashboard
but replaces animation with a static progress marker. Non-TTY output, CI, `TERM=dumb`, and
`SCREEN_READER=1` automatically use the line-oriented path so automation and assistive technology do
not receive cursor-control sequences.

The executable TUI scenarios, advanced terminal and designer personas, and latest committed
production-renderer screenshots and GIF are documented in
[TUI experience](test/bdd/features/tui-experience.md). TUI pull requests must refresh that evidence
with `pnpm tui:evidence` and embed it in the pull request body.

## GitHub Copilot Squad

The repository's eleven research personas — ten CLI operators and one repository contributor — are also an SDK-first
[Squad](https://bradygaster.github.io/squad/docs/get-started/five-minute-start/) for GitHub
Copilot. [`squad.config.ts`](squad.config.ts) is the typed source of truth and imports the same
[`PERSONA_DEFINITIONS`](src/experience/personas.ts) used by the experiment harness. Scribe, Ralph,
Rai, and Fact Checker add redacted memory, read-first triage, safety review, and independent
verification.

Install dependencies, create ignored local Squad state, verify generated assets, and start the
pinned SDK runtime:

```bash
pnpm install --frozen-lockfile
pnpm squad:bootstrap
pnpm squad:check
pnpm squad:copilot
```

Address a persona directly, or describe the task for deterministic routing. The runtime enforces
per-agent tool allowlists, canonical write paths, redacted and approval-gated permission requests,
clarification limits, and reviewer lockouts. These development controls supplement, but never
replace, the migration CLI's Effect services, dry-run, approval, checkpoint, idempotency, and retry
invariants.

Squad `0.11.0` is alpha software and is pinned exactly. Mutable decisions, histories, casting
state, templates, sessions, and logs are ignored because they may contain operational context.
Only static configuration and generated definitions are committed. Use `pnpm squad:doctor` for
installation diagnostics, `pnpm squad:status` for resolution details, and `pnpm squad:nap` to
preview context compaction.

## Documentation

| Need                                                    | Read                                                                                                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install, authenticate, migrate, resume, or troubleshoot | [Using the CLI](docs/using-the-cli.md)                                                                                                                                                                |
| Understand the system and safety model                  | [Architecture](docs/architecture.md)                                                                                                                                                                  |
| Understand durable workflow and topology decisions      | [Architecture decisions](docs/decisions/)                                                                                                                                                             |
| Develop and test the project                            | [Contributing](CONTRIBUTING.md) and [Testing](docs/testing.md)                                                                                                                                        |
| Review the interactive terminal dashboard experience    | [TUI experience](test/bdd/features/tui-experience.md)                                                                                                                                                 |
| Operate or improve the CLI through an agent             | [Migration operations](skills/ado-to-github-teams/SKILL.md), [Optimize UX](skills/optimize-ux/SKILL.md), [Optimize DX](skills/optimize-dx/SKILL.md), and [Optimize TUI](skills/optimize-tui/SKILL.md) |
| Report a vulnerability                                  | [Security policy](SECURITY.md)                                                                                                                                                                        |

Open a [GitHub issue](https://github.com/MSFT-TKENDRICK/ado-to-github-teams/issues) for reproducible
bugs or feature requests. Do not include credentials, tenant identifiers, personal data, reports,
or migration state.

## License

Licensed under the [MIT License](LICENSE).
