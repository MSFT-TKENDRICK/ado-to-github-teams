# Area — devcontainers

## Current state — honest

**This repository currently ships no `.devcontainer/` directory.** A `Get-ChildItem
.devcontainer` at the repo root returns nothing; the top-level layout has no
`.devcontainer.json` file either. There is a `Dockerfile` and a `compose.yaml` at the
root, but those are runtime / deployment concerns, not a Dev Containers configuration
for VS Code, GitHub Codespaces, or a Dev Container CLI.

**Do not invent one.** Fabricating a devcontainer configuration to satisfy a checklist
would be exactly the kind of surface-widening the [../rubber-duck.md](../rubber-duck.md)
gate must reject.

## Nine-category pains this area may reveal

- **3. Discoverability failures.** A contributor expecting "click the badge, open in a
  Codespace" will find no badge and no `.devcontainer/`. That is not itself a bug — this
  repo's contributor policy is worktree-based per `AGENTS.md`, not
  container-of-the-week — but if the docs ever imply devcontainer support, the docs are
  wrong.
- **8. Setup/build/test/hook/lint/agent-config friction.** A future
  `.devcontainer/devcontainer.json` would need to preserve every current invariant:
  Corepack-managed pnpm 10.34.5, Node 22.18–25, lefthook installed as part of
  `postCreateCommand`, and no bypass of the `AGENTS.md` worktree rule.
- **9. Documentation-vs-reality mismatch.** README and CONTRIBUTING deliberately do **not**
  document devcontainer support today; keeping them silent is honest. Adding a
  half-working devcontainer without updating both would create instant category-9 drift.

## Repo-specific anchors to check

- `Dockerfile` and `compose.yaml` at the root — these are for the migration worker /
  runtime path, **not** for contributor onboarding. Do not conflate them with a
  devcontainer.
- `AGENTS.md` mandates **one worktree per task branch**. Any future devcontainer must
  support (not bypass) that policy — probably by mounting the worktree, not the parent
  checkout.

## Supporting numeric signals from `src/experience/dev-experience.ts`

None. Devcontainers are not modeled by any of the five signals.

## Likely evidence shape for a change in this area

1. If a devcontainer is genuinely added: a description of the exact scenarios it enables
   (Codespaces? Dev Container CLI?), the Node/pnpm/lefthook wire-up, and how it preserves
   `AGENTS.md`'s worktree rule.
2. New `.devcontainer/devcontainer.json` (and any Dockerfile-in-devcontainer), plus
   updates to README `## Contributor quick start`, README prereqs, and
   `docs/architecture.md` where topology moves — all in the same commit.
3. A `test/unit/documentation/dx-docs.test.ts` assertion that the new prose commitments
   (e.g. "Codespaces supported") are backed by actual files that exist.

If, after review, the answer is "no devcontainer is warranted this cycle", the correct DX
verdict is **stopped — out of scope**, not an invented file. That is a legitimate outcome
per [../qualitative-evidence.md](../qualitative-evidence.md).
