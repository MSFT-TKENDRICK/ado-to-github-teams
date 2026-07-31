# Supporting signals

These six deterministic measurements in `src/experience/dev-experience.ts` are supporting
evidence for a qualitative DX critique. They are not the definition of acceptance, and they
are not sufficient by themselves to conclude a cycle. See
[qualitative evidence](qualitative-evidence.md) for what actually counts as evidence, and
[workflow](workflow.md) for the nine pain categories the critique operates against.

| Signal                       | Function                      | Healthy value                           |
| ---------------------------- | ----------------------------- | --------------------------------------- |
| Root package script surface  | `countPackageScripts`         | Reported verbatim in `CONTRIBUTING.md`  |
| Documented script coverage   | `documentedScriptRatio`       | 1.0 when every script is named in prose |
| Git-hook enforcement         | `hookEnforcementStatus`       | `enforced`                              |
| Prettier config surface      | `duplicateFormatConfigCount`  | `1`                                     |
| Turbo `inputs` resolvability | `danglingTurboInputs`         | Empty array                             |
| Contributor on-ramp          | `contributorOnboardingStatus` | `streamlined`                           |

The measurements are implemented as pure typed functions over already-loaded data, so they
are unit-testable without any live filesystem or network access. The runnable driver script
loads the data once and calls the same functions.

## Why these six and not more

Each signal corresponds to a concrete previously-observed regression in this repository:

- Script count drifted (`personas.ts` said "24", real was 29).
- The `lefthook` binary was referenced by installed hooks but not declared as a dependency,
  so any fresh clone fell through to a fail-open branch.
- Two Prettier configs coexisted at the root and diverged.
- `turbo.json` `lint.inputs` pointed at `../../` paths outside the repo.
- Contributor docs required global pnpm, install, build, and manual Squad commands while a separate
  validation section prescribed three overlapping universal gates.

They earn their place because they catch a regression the qualitative critique cannot verify
by reading prose alone. They do not earn the right to define the review verdict.

## Interpreting `documentedScriptRatio`

The "documented" set is whatever the reference documentation names. This signal is not
auto-scraped; the caller passes the documented set explicitly so the value is deliberate.

## What these signals deliberately do not represent

- A DX verdict. Verdicts come from qualitative review against the nine pain categories in
  [workflow](workflow.md).
- Persona-modeled friction. That belongs to `npm run experiment:personas` and
  [Optimize UX](../../optimize-ux/SKILL.md).
- Migration safety invariants. Those live in application code and integration tests and are
  never relaxed for DX convenience.
- Human wall-clock timing except behind explicit `DX_MEASURE_TIMING=1`.
