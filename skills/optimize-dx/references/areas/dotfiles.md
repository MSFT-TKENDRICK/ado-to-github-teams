# Area — dotfiles

## Current state — honest

**This repository currently ships no contributor-facing dotfiles convention.** There is
no `.dotfiles/` directory, no `chezmoi` or `yadm` layout, no `install-dotfiles.sh`, and
no README section that instructs a contributor to symlink personal dotfiles into place.

The repository does contain a number of dotfiles at the _repo_ root
(`.editorconfig`, `.eslintrc.json`, `.gitignore`, `.gitattributes`, `.prettierrc.json`,
`.prettierignore`, `.dockerignore`, `.env.schema`, `.mcp.json`). Those are **repo-scoped
configuration**, not contributor dotfiles, and they belong in the
[repository-structure-and-config.md](repository-structure-and-config.md) area. This file
is only about _personal_ / _machine-scoped_ dotfiles.

**Do not invent a personal-dotfiles layout.** Adding one without a real contributor need
is category-8 (config-surface) friction and would violate the
[../rubber-duck.md](../rubber-duck.md) gate.

## Nine-category pains this area may reveal

- **3. Discoverability failures.** A contributor coming from a repo that ships suggested
  dotfiles may search for them here and find nothing. That is not itself a bug — the
  policy is "your machine, your dotfiles" — but if docs ever imply the opposite, they
  drift.
- **1. Developer pains and frustration points.** Recommended VS Code / IDE settings
  belong to the workspace, not to personal dotfiles. The repo's `.editorconfig` and
  `.prettierrc.json` cover the auto-format contract already; a redundant `.vscode/`
  or personal-config layer would fight them (see
  [repository-structure-and-config.md](repository-structure-and-config.md)).
- **9. Documentation-vs-reality mismatch.** README and CONTRIBUTING do **not** currently
  document a dotfiles workflow. That silence is honest. Adding a partial one without
  updating both would create instant drift.

## Repo-specific anchors to check

- Root **repo-scoped** dotfiles (not personal): `.editorconfig`, `.eslintrc.json`,
  `.gitignore`, `.gitattributes`, `.prettierrc.json`, `.prettierignore`, `.dockerignore`,
  `.env.schema`, `.mcp.json`. Personal dotfiles do not belong at the root and do not
  belong committed.
- `AGENTS.md` never authorizes committing per-contributor machine configuration. Any
  future personal-dotfiles surface must live outside the tree or be strictly opt-in.

## Supporting numeric signals from `src/experience/dev-experience.ts`

None. Dotfiles are not modeled by any of the five signals.

## Likely evidence shape for a change in this area

1. If a genuine contributor dotfiles workflow is added: a description of the specific
   scenario it enables (shared shell aliases? shared Git hooks? shared editor keybinds?),
   why the current in-repo config does not already cover it, and how it stays _opt-in_.
2. New file(s) and README / CONTRIBUTING guidance in the same commit; no leaving prose
   silent.
3. Never commit personal dotfiles as-if-mandatory. Never conflate personal dotfiles with
   repo-scoped root config.

If, after review, the answer is "no personal-dotfiles convention is warranted this
cycle", the correct DX verdict is **stopped — out of scope**, not an invented directory.
