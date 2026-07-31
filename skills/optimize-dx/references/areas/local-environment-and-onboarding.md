# Area — local environment and onboarding

## Scope

The fresh-clone-to-first-passing-change path. Prereqs (Node.js, pnpm, git), package-manager
bootstrap, the
literal ordered steps in README `## Contributor quick start`, and every friction point a
contributor hits before they have ever edited code.

## Nine-category pains this area may reveal

- **3. Discoverability failures.** "What version of Node?" and "how do I install pnpm?" are
  the two most-asked new-contributor questions. If they are not obvious from the README
  prereqs, this is a discoverability failure.
- **4. Unnecessary steps.** Any manual step that could be a script or a hook.
- **5. Poor or missing feedback and error messages.** `pnpm install --frozen-lockfile` on a
  drifted lockfile surfaces a real but unhelpful pnpm error; the README already documents the
  recovery path (do not hand-edit, regenerate, investigate the cause).
- **6. Slow or cumbersome iteration loops.** If `pnpm install` needs
  `--frozen-lockfile` **and** a rebuild **and** `pnpm squad:bootstrap` **and** a `pnpm build`
  before a contributor can try anything, the on-ramp is longer than it should be.
- **8. Setup/build/test/hook/lint/agent-config friction.** Environment validation via Varlock
  and `.env.schema` — good when it prevents leaked credentials, bad when a contributor cannot
  figure out what to put in `.env.local`.

## Repo-specific anchors to check

- Prereqs: **Node.js 22.18 or later and earlier than Node.js 26** (also asserted by
  `"engines": {"node": ">=22.18.0 <26"}` in `package.json`), **pnpm 10.34.5 installed with
  `npm install --global pnpm@10.34.5`** (asserted by `"packageManager": "pnpm@10.34.5"`),
  **Git 2.31+ with worktree support**. Both
  README.md and CONTRIBUTING.md say this; drift between them is category 9.
- The literal shortest-path steps README currently documents:
  1. `npm install --global pnpm@10.34.5`
  2. `pnpm install --frozen-lockfile`
  3. `pnpm build`
  4. `node bin/run.js --sandbox happy-path`
     and the fresh-clone contributor must be able to reach step 4 without reading anything else.
- `pnpm squad:bootstrap` is **optional** for the migration CLI itself; the README labels it
  correctly. Requiring it up front would widen onboarding.
- Debug on-ramps: `NO_TUI=1` for line-oriented output, `pnpm squad:doctor` for install-health,
  `pnpm secrets:check` for env validation. Any that stop working break this area.

## Supporting numeric signals from `src/experience/dev-experience.ts`

- `countPackageScripts` — larger numbers make the "which script do I run?" question harder;
  documenting them all in `CONTRIBUTING.md`'s Common commands table is the mitigation.
- `hookEnforcementStatus` — `enforced` means a fresh clone automatically gets pre-commit and
  pre-push protection; `fail-open` means the on-ramp silently strips a safety net.

## Likely evidence shape for a change in this area

1. A concise description of the on-ramp step added, removed, or clarified, and which category
   it addresses.
2. Updated README `## Contributor quick start`, updated `CONTRIBUTING.md` Prerequisites and
   Common commands table, and updated `docs/testing.md` if a validation command changed — all
   in the same commit.
3. Do **not** claim "onboarding is 30% faster"; there is no wall-clock timing in this loop
   unless `DX_MEASURE_TIMING=1` is set (and CI never sets it).
