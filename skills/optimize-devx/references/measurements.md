# Measurements reference

The five measurements are implemented in `src/experience/dev-experience.ts` as
pure typed functions over already-loaded data, so they are unit-testable
without any live filesystem or network access. The runnable driver script
loads the data once and calls the same functions.

| Measurement                  | Function                     | Healthy value                           |
| ---------------------------- | ---------------------------- | --------------------------------------- |
| Root pnpm script surface     | `countPackageScripts`        | Reported verbatim in `CONTRIBUTING.md`  |
| Documented script coverage   | `documentedScriptRatio`      | 1.0 when every script is named in prose |
| Git-hook enforcement         | `hookEnforcementStatus`      | `enforced`                              |
| Prettier config surface      | `duplicateFormatConfigCount` | `1`                                     |
| Turbo `inputs` resolvability | `danglingTurboInputs`        | Empty array                             |

## Why these five and not more

Each measurement corresponds to a concrete, previously-observed regression:

- Script count drifted (personas.ts said "24", real was 29).
- The lefthook binary was referenced by installed hooks but not declared as a
  dependency, so any fresh clone fell through to a fail-open branch.
- Two Prettier configs coexisted at the root and diverged.
- `turbo.json` `lint.inputs` pointed at `../../` paths outside the repo.

## Interpreting `documentedScriptRatio`

The "documented" set is whatever the reference documentation names. This skill
does not auto-scrape headings; the caller passes the documented set explicitly
so the measurement is deliberate.

## What this skill deliberately does not measure

- Persona-modeled friction. That belongs to `pnpm experiment:personas` and
  [Optimize UX](../optimize-ux/SKILL.md).
- Migration safety invariants. Those live in application code and integration
  tests and are never relaxed for DX convenience.
- Human wall-clock timing except behind explicit `DX_MEASURE_TIMING=1`.
