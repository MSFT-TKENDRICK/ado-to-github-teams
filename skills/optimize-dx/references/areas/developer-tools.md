# Area — developer tools (build, test, lint, debugging)

## Scope

The tools contributors invoke every iteration: TypeScript (`tsc`), tsx, Vitest, ESLint,
Prettier, rimraf, cross-env, oclif's build-time helpers, nitro for the worker path, turbo
where it caches. Also the debugging affordances: `NO_TUI=1`, single-file Vitest runs,
`--sandbox` scenarios.

## Nine-category pains this area may reveal

- **6. Slow or cumbersome iteration loops.** `pnpm test:unit` should be fast; `pnpm check`
  should be honest about wall-clock; the pre-push `dx-gate` should stay under three
  minutes (currently measured at ~91 seconds on the reference workstation, per
  `lefthook.yml`).
- **7. Debugging friction.** Contributors need a way to run one file (`pnpm vitest run
test/unit/experience/dev-experience.test.ts`), suppress the TUI (`NO_TUI=1` or `--no-tui`),
  and get a plain-line trace when the interactive dashboard hides the failure.
- **3. Discoverability failures.** 30 root pnpm scripts is a big surface. The
  `CONTRIBUTING.md` `## Common commands` table is the mitigation — if a real script is
  absent from that table, discoverability regresses.
- **5. Poor or missing feedback and error messages.** ESLint or Prettier configured to
  silently accept a wrong style is worse than not running it at all.

## Repo-specific anchors to check

- Real scripts today (verified against `package.json` — 30 root scripts):
  - Build: `build`, `worker:build`, `dev`, `worker:dev`
  - Test: `test`, `test:unit`, `test:contract`, `test:integration`, `test:bdd`,
    `package:smoke`
  - Lint/format: `lint`, `typecheck`, `format`, `format:check`
  - Secrets: `secrets:validate`, `secrets:scan`, `secrets:check`
  - Squad: `squad:bootstrap`, `squad:build`, `squad:check`, `squad:doctor`,
    `squad:status`, `squad:copilot`, `squad:nap`
  - Persona/DX: `experiment:personas`, `optimize:ux`, `optimize:dx`
  - TUI evidence: `tui:evidence`, `tui:evidence:render`
  - Aggregate: `check`
- README `### Debugging & troubleshooting` names `NO_TUI=1`, single-file Vitest runs, and
  `pnpm squad:doctor`. Removing any of these without a replacement is category-7 friction.
- `test/bdd/` uses Cucumber; the runner is `scripts/run-bdd.ts`. That path is a real script
  entry — do not confuse it with a Vitest suite.
- ESLint is `eslint ^8.57.1` (v8). AGENTS.md is explicit that ESLint major upgrades are
  out of scope for this loop; see [../safety-and-delivery.md](../safety-and-delivery.md).

## Supporting numeric signals from `src/experience/dev-experience.ts`

- `countPackageScripts` — currently 30, cited in `CONTRIBUTING.md` and
  `src/experience/personas.ts`.
- `documentedScriptRatio` — how many of those 30 scripts are named in the documented set
  passed by the runner. Supporting only.

## Likely evidence shape for a change in this area

1. Description of the tooling change (a script added, deleted, renamed; a debugging
   affordance improved; a Vitest configuration corrected) and the category it addresses.
2. Updates to `CONTRIBUTING.md`'s Common commands table, README's Validation section, and
   `docs/testing.md` where relevant — same commit.
3. If a script is renamed, sweep prose per `RETIRED_NAMES` in
   `test/unit/documentation/dx-docs.test.ts` and extend that guard if needed.
