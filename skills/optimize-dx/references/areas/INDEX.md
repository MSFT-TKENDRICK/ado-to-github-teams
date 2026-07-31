# DX area catalog

This index enumerates every developer-experience area Theo (`cli-contributor-engineer`) may
critique against the nine pain categories in [../workflow.md](../workflow.md). Each area is
covered by exactly one dedicated file so discoverability failures (category 3) do not compound
with tooling friction (category 8). Nothing is grouped: distinct concerns get distinct files.

The runnable driver `pnpm optimize:dx` rotates through this catalog one area per iteration in
list order, wrapping at the end. Iterations control how many area passes the driver performs,
not whether the surface is truly better — that judgment stays qualitative and belongs to Theo.

Every area file below is grounded in **this repository's actual current state**, not generic
advice. When the repo
currently has no artifact for an area (for example, no `.devcontainer/` directory and no
dotfiles convention), the file says so explicitly rather than fabricating one.

## Areas

| #   | Area id                            | File                                                                       | One-line focus                                                                                 |
| --- | ---------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `documentation`                    | [documentation.md](documentation.md)                                       | README, CONTRIBUTING, docs/, AGENTS.md accuracy and doc-vs-reality drift.                      |
| 2   | `repository-structure-and-config`  | [repository-structure-and-config.md](repository-structure-and-config.md)   | Root config surface: tsconfig, prettier, eslint, turbo, vitest, editorconfig, .env.schema.     |
| 3   | `local-environment-and-onboarding` | [local-environment-and-onboarding.md](local-environment-and-onboarding.md) | Fresh-clone path to a passing local change: prereqs, corepack, install, build, sandbox.        |
| 4   | `file-folder-hierarchy`            | [file-folder-hierarchy.md](file-folder-hierarchy.md)                       | Discoverability of top-level directories (`src`, `test`, `scripts`, `skills`, `apps`, etc.).   |
| 5   | `projects-and-workspaces`          | [projects-and-workspaces.md](projects-and-workspaces.md)                   | The root package vs the half-formed `apps/cli` staged workspace; `pnpm-workspace.yaml`.        |
| 6   | `packages-and-dependencies`        | [packages-and-dependencies.md](packages-and-dependencies.md)               | `package.json` deps/devDeps, pnpm overrides and catalog, `pnpm-lock.yaml`, engines constraint. |
| 7   | `developer-tools`                  | [developer-tools.md](developer-tools.md)                                   | Build/test/lint/debug tools: tsc, tsx, vitest, eslint, prettier, oclif, NO_TUI.                |
| 8   | `git-hooks`                        | [git-hooks.md](git-hooks.md)                                               | `lefthook.yml` pre-commit and pre-push contracts and the "never bypass" rule.                  |
| 9   | `git-github-cli-and-extensions`    | [git-github-cli-and-extensions.md](git-github-cli-and-extensions.md)       | Contributor use of `git` and `gh`; how this repo does and does not ship extensions.            |
| 10  | `devcontainers`                    | [devcontainers.md](devcontainers.md)                                       | This repository currently ships **no** `.devcontainer/`; the file records that honestly.       |
| 11  | `dotfiles`                         | [dotfiles.md](dotfiles.md)                                                 | This repository currently ships **no** contributor dotfiles convention; recorded honestly.     |
| 12  | `cli-invocation-and-naming`        | [cli-invocation-and-naming.md](cli-invocation-and-naming.md)               | Public package name, primary executable, aliases, shipped help, and errors.                    |
| 13  | `packaging-and-distribution`       | [packaging-and-distribution.md](packaging-and-distribution.md)             | Consumer install path, tarball contents, bin mappings, and runtime files.                      |
| 14  | `release-and-versioning`           | [release-and-versioning.md](release-and-versioning.md)                     | Pre-1.0 policy, preview channel, provenance, automation, and upgrades.                         |
| 15  | `build-package-and-deploy`         | [build-package-and-deploy.md](build-package-and-deploy.md)                 | Build host, artifact contract, local default, cloud opt-in, and deployment guidance.           |

## How to use this catalog

- Load only the area file(s) relevant to the current critique. Do not read the whole catalog
  before starting — that is a discoverability failure of its own (category 3).
- Each area file names the pains it critiques against, likely evidence shape (per
  [../qualitative-evidence.md](../qualitative-evidence.md)), and the supporting numeric signals
  from `src/experience/dev-experience.ts` that apply to that area, if any. Absence of a
  supporting signal is not a defect — most areas are qualitative by design.
- The runnable driver's iteration count is a rotation budget, not a convergence claim. See
  [../qualitative-evidence.md](../qualitative-evidence.md) for what `converged`, `stopped`, and
  `blocked` mean in this loop.
- Areas 12 through 15 require executable command or public artifact evidence. Documentation alone
  cannot accept them.
