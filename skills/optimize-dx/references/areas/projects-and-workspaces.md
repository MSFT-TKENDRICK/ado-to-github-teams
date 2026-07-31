# Area — projects and workspaces

## Scope

`pnpm-workspace.yaml`, the root package, `apps/cli/`, any future `packages/*` entry, and the
relationship between the root `npm run check` gate and workspace-level commands. Includes the
transitional monorepo state and how it is communicated to contributors.

## Nine-category pains this area may reveal

- **2. Confusing or unintuitive operations.** "Where do I add a new package?" and "why does
  `npm run check` mostly ignore `apps/cli`?" are both real questions. The current answer is that the
  root package is the active migration CLI and `apps/cli/` is a staged shell — but a
  contributor who does not know that will wire the wrong file.
- **8. Setup/build/test/hook/lint/agent-config friction.** `pnpm-workspace.yaml` currently
  declares `apps/*` and `packages/*` (the latter directory does not exist yet). pnpm treats
  the missing glob as empty, so it does not error, but a contributor who runs
  `pnpm --filter '...' build` may be surprised.
- **9. Documentation-vs-reality mismatch.** README and CONTRIBUTING identify `apps/cli` as a
  compatibility shell exercised by package smoke, not the normal feature-work target.

## Repo-specific anchors to check

- `pnpm-workspace.yaml` currently declares:
  - `apps/*` (populated by `apps/cli/`)
  - `packages/*` (no directory currently exists)
  - a `catalog:` block pinning `@types/node`, `typescript`, and `vitest`
  - `onlyBuiltDependencies:` allowlisting `esbuild`, `keytar`, `lefthook`, `turbo`, and
    the two `@azure/msal-node-*` packages
- Root `package.json` is the public `@msft-tkendrick/a2g` package. Its `"bin"` maps both the
  primary `a2g` executable and the `ado-to-github-teams` compatibility alias to `./bin/run.js`;
  the shipped entry points are at the **root**, not in `apps/cli/`.
- The root `npm run check` script runs `npm --prefix apps/cli run build && node
scripts/package-smoke.mjs` in its `package:smoke` step; that is currently the _only_
  point where `apps/cli` is exercised from the root gate.
- README `### Architecture / repo map` and CONTRIBUTING `## Prerequisites` **both** state
  the transitional status honestly. Both must move together.

## Supporting numeric signals from `src/experience/dev-experience.ts`

None directly. `countPackageScripts` measures the root `package.json` only; workspace
member scripts are not counted here.

## Likely evidence shape for a change in this area

1. Description of the workspace-level change (a new package added, `apps/cli/` retired or
   promoted, a `catalog:` entry updated) and which pain it addresses.
2. Updated `pnpm-workspace.yaml`, `pnpm-lock.yaml` (regenerated, never hand-edited),
   README `### Architecture / repo map`, CONTRIBUTING transitional-status paragraph, and
   `docs/architecture.md` — same commit.
3. If the role of `apps/cli` changes, update its contributor-facing compatibility-shell
   description in the same commit.
