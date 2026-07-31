# Area — packages and dependencies

## Scope

`package.json` `dependencies` and `devDependencies`, `pnpm-lock.yaml`, `pnpm.overrides`,
`pnpm-workspace.yaml`'s `catalog:` block, engine constraints, and the
`onlyBuiltDependencies` allowlist. How contributors add, remove, upgrade, and audit
packages.

## Nine-category pains this area may reveal

- **6. Slow or cumbersome iteration loops.** A drifted lockfile fails
  `pnpm install --frozen-lockfile` on a fresh clone and blocks all downstream steps.
- **8. Setup/build/test/hook/lint/agent-config friction.** A dep added to solve one problem
  while three other equivalent deps stay in the tree is footprint growth. Every dep is a
  supply-chain surface and a bundle-size hit for `dist/`.
- **5. Poor or missing feedback and error messages.** Version pins that satisfy the parser
  but do not match reality (`^` vs `~` vs exact) cause silently-different behavior across
  contributor machines.
- **9. Documentation-vs-reality mismatch.** README and CONTRIBUTING name the tools
  (`lefthook 2.1.10`, `pnpm 10.34.5`, `typescript ^5.7.2`, etc.); those must match
  `package.json`.

## Repo-specific anchors to check

- `"packageManager": "pnpm@10.34.5"` — the exact pnpm version Corepack activates. Bumping
  this **must** also bump the README and CONTRIBUTING prerequisites paragraph.
- `"engines": {"node": ">=22.18.0 <26"}` — the tested Node range. Same rule.
- `pnpm.overrides` currently pins `@workflow/world` to `4.2.1`. Overrides silently mask
  transitive drift; removing one requires a full lockfile review.
- `pnpm-workspace.yaml` `catalog:` block pins `@types/node`, `typescript`, and `vitest` for
  every workspace member. When bumping any of these at the root, update the catalog and
  regenerate the lockfile.
- `onlyBuiltDependencies:` at the workspace level is the security posture — only these
  named packages run install scripts. Adding a new native module requires opting it in
  here explicitly.
- `lefthook` is a **devDependency** (`2.1.10`); this is what makes hook enforcement
  reproducible. `test/unit/documentation/dx-docs.test.ts` asserts that
  `pkg.devDependencies.lefthook` is defined. Deleting the dep silently while leaving
  `lefthook.yml` in place would produce a `fail-open` `hookEnforcementStatus`.
- The `.env.schema` + Varlock combination is how application-side env dependencies are
  declared; do not conflate app env with package deps, but do read
  [local-environment-and-onboarding.md](local-environment-and-onboarding.md) alongside.

## Supporting numeric signals from `src/experience/dev-experience.ts`

- `hookEnforcementStatus` — indirectly, because deleting the `lefthook` devDependency
  breaks it. Otherwise this area is qualitative.

## Likely evidence shape for a change in this area

1. Description of the package change (added/removed/upgraded/pinned), the reason, and the
   category it addresses.
2. Regenerated `pnpm-lock.yaml` (never hand-edited). Fresh
   `pnpm install --frozen-lockfile` must succeed.
3. Updated README/CONTRIBUTING prereq paragraph **only if** the change bumps a version
   contributors interact with directly (Node, pnpm, lefthook, TypeScript major).
4. Green `pnpm check` including `pnpm test:unit`, which will re-run the DX-docs drift
   assertion on `lefthook`.
