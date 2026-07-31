# Area — local environment and onboarding

## Scope

The existing-clone-or-worktree-to-first-running-change path. The repository contributor is the
primary audience. Review Node/npm/Git prerequisites, the literal ordered steps in README
`## Contributor quick start`, the single baseline gate, and every friction point before the
contributor edits code.

## Nine-category pains this area may reveal

- **3. Discoverability failures.** "What version of Node?" and "how do I install pnpm?" are
  the two most-asked new-contributor questions. If they are not obvious from the README
  prereqs, this is a discoverability failure.
- **4. Unnecessary steps.** Any manual step that could be a script or a hook.
- **5. Poor or missing feedback and error messages.** `npm run setup` on a drifted lockfile
  surfaces a real but unhelpful pnpm error; the README documents the
  recovery path (do not hand-edit, regenerate, investigate the cause).
- **6. Slow or cumbersome iteration loops.** Global package-manager installation, Corepack, a
  separate build, or a manual Squad bootstrap before the first safe run is unacceptable.
- **8. Setup/build/test/hook/lint/agent-config friction.** Environment validation via Varlock
  and `.env.schema` — good when it prevents leaked credentials, bad when a contributor cannot
  figure out what to put in `.env.local`.

## Repo-specific anchors to check

- Prereqs: **Node.js 22.18 or later and earlier than Node.js 26** and **Git 2.31+**. npm is supplied
  by Node. The pinned pnpm version is an implementation detail of `npm run setup`, not a global
  prerequisite.
- The literal shortest path is exactly:
  1. `npm run setup`
  2. `npm run dev -- --sandbox happy-path`
- Setup installs the frozen lockfile, hooks, and ignored Squad state internally. The contributor
  does not run separate package-manager, build, or Squad commands.
- The universal baseline gate is exactly `npm run check`. `npm test` overlaps it and is optional;
  `npm run test:bdd` is conditional on migration scenario, Gherkin, or TUI behavior changes.
- Debug on-ramps: `NO_TUI=1`, `npm run squad:doctor`, and `npm run secrets:check`.

## Supporting numeric signals from `src/experience/dev-experience.ts`

- `countPackageScripts` — larger numbers make the "which script do I run?" question harder;
  documenting them all in `CONTRIBUTING.md`'s Common commands table is the mitigation.
- `hookEnforcementStatus` — `enforced` means a fresh clone automatically gets pre-commit and
  pre-push protection; `fail-open` means the on-ramp silently strips a safety net.
- `contributorOnboardingStatus` — `streamlined` requires the exact two-command on-ramp, a pinned
  setup script, and exactly one baseline gate. Any extra required command is `friction`.

## Likely evidence shape for a change in this area

1. A concise description of the on-ramp step added, removed, or clarified, and which category
   it addresses.
2. Updated README `## Contributor quick start`, updated `CONTRIBUTING.md` Prerequisites and
   Common commands table, and updated `docs/testing.md` if a validation command changed — all
   in the same commit.
3. Do **not** claim "onboarding is 30% faster"; there is no wall-clock timing in this loop
   unless `DX_MEASURE_TIMING=1` is set (and CI never sets it).
