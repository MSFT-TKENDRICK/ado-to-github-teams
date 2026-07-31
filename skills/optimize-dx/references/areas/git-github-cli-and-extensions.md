# Area — Git / GitHub CLI and extensions

## Scope

How contributors use `git` and `gh` on this repository, worktree conventions per
`AGENTS.md`, PR topology, and whether this repository ships any CLI extensions (it does
not, currently). Also authentication expectations: PATs, federated identity, SAML/SSO.

## Nine-category pains this area may reveal

- **2. Confusing or unintuitive operations.** Worktree isolation (one worktree per task
  branch) is required by `AGENTS.md`; contributors who assume one-checkout-many-branches
  will fight the policy.
- **4. Unnecessary steps.** Every extra manual `git worktree`, `gh auth refresh`, or
  `gh api` invocation before a contributor can open a PR is friction.
- **3. Discoverability failures.** "How do I open a PR?" — this repo uses app-native PRs
  (per `AGENTS.md`), not third-party stack extensions. That is easy to miss.
- **5. Poor or missing feedback and error messages.** A `gh` call that fails on SAML/SSO
  produces an opaque 403 unless the token is authorized; the "Edit a PR title" flow uses
  the app tool (`update_pull_request`) precisely because `gh pr edit` uses GraphQL and
  fails on unauthorized tokens.

## Repo-specific anchors to check

- `AGENTS.md` sections:
  - **Worktree isolation** — one worktree, one branch, one app-native PR per task.
  - **Git and stacked pull requests** — bottom-up creation, GitHub Stacks REST API, no
    third-party extensions. Conventional commits with the Copilot co-author trailer are
    required on every commit.
  - **Security and operational safety** — least-privilege credentials, prefer federated
    identity over PATs.
- README `## Contributor quick start` and `CONTRIBUTING.md` **do not** currently document
  a `gh` prerequisite; the CLI itself does not require `gh` to build, test, or run. If a
  developer script or hook grows a `gh` dependency, prereqs must move.
- This repository ships **no** custom `gh` extensions and no `git` hooks beyond
  `lefthook.yml`. If that changes, this file must move.
- The Copilot co-author trailer is exact and enforced by the project policy in
  `AGENTS.md`:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`.
- Squad orchestration uses `gh` under the hood for cross-session coordination, but that
  is orchestration-side, not contributor-invoked.

## Supporting numeric signals from `src/experience/dev-experience.ts`

None. This area is purely qualitative; no useful count captures whether the worktree
policy is discoverable.

## Likely evidence shape for a change in this area

1. Description of the git or `gh` workflow change (a worktree convention clarified, a
   `gh` fallback added, a manual step replaced with a script) and the category addressed.
2. Updates to `AGENTS.md`, `CONTRIBUTING.md`, and README where the shape of the workflow
   changes — same commit.
3. If a new `gh` prerequisite is introduced, add it to README prereqs and mention it in
   `CONTRIBUTING.md` in the same commit; do not leave the on-ramp implicit.
4. Never bypass the mandatory conventional-commit + Copilot co-author trailer for
   convenience; that trailer is category-9 "prose vs reality" if it drifts.
