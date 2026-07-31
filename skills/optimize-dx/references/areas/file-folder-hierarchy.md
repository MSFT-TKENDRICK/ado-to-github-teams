# Area — file and folder hierarchy

## Scope

The top-level layout under the repository root: `src/`, `test/`, `scripts/`, `skills/`,
`apps/`, `bin/`, `deploy/`, `dist/`, `docs/`, `reports/`, `sandbox/`, `.github/`, `.squad/`.
Not the contents of any one file — those belong to other areas — but the _shape_
contributors have to hold in their head.

## Nine-category pains this area may reveal

- **3. Discoverability failures.** A contributor should be able to guess where a given
  concern lives: an Effect service in `src/`, a script entry point in `scripts/`, an agent
  skill in `skills/`, a sandbox scenario in `sandbox/`.
- **1. Developer pains and frustration points.** Two directories with overlapping mandates
  (`skills/optimize-dx/` and `.github/skills/optimize-dx/` for example) are OK **only** if
  the relationship is documented and enforced — here, the second is a generated mirror of the
  first, produced by `pnpm squad:build`, and prose that ever suggests otherwise is a bug.
- **9. Documentation-vs-reality mismatch.** The README `### Architecture / repo map` names
  every top-level directory; if a new one is added without being named, the map is stale.

## Repo-specific anchors to check

- README `### Architecture / repo map` currently lists: `src/`, `test/`, `scripts/`,
  `skills/`, `apps/cli/`, `sandbox/`. If a top-level directory that contributors will touch
  is added or removed, this list must move with it.
- `bin/` — thin oclif launcher (`bin/run.js`) that loads `dist/cli.js`. Contributors need to
  know `pnpm build` must run first for `node bin/run.js ...` to work.
- `dist/` — generated. `.gitignore` excludes it; a contributor should never edit it.
- `reports/` — generated persona experiment output. Also ignored. Contributors sometimes
  mistake it for a doc directory.
- `.squad/` — mutable Squad state; contributors must not commit the mutable subdirectories
  (`decisions/`, `sessions/`, `logs/`) per `AGENTS.md`.
- `docs/` — architecture, testing, and using-the-cli references. Grows over time; a doc
  filename that does not match its `# Heading` is category 9.
- `apps/cli/` — the staged package shell for the eventual published CLI. See
  [projects-and-workspaces.md](projects-and-workspaces.md) for the workspace-level
  discussion; from the pure-layout perspective it is a directory a contributor may not need
  to touch.

## Supporting numeric signals from `src/experience/dev-experience.ts`

None. This area is purely qualitative — no useful count captures whether a folder name is
guessable.

## Likely evidence shape for a change in this area

1. Description of the layout change (directory added, moved, renamed, or split) and which
   pain category it addresses.
2. Updated README `### Architecture / repo map`, updated `docs/architecture.md` where the
   change affects topology, and updated `.gitignore` / `.gitattributes` when a generated or
   binary path moves — all in the same commit.
3. If a directory rename means retired names could resurface, extend the
   `RETIRED_NAMES` guard in `test/unit/documentation/dx-docs.test.ts`.

Prefer **renaming or deleting** over adding a new top-level directory. Every new top-level
directory increases the shape a contributor has to keep in memory.
