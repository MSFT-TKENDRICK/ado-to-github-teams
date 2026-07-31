# Area — repository structure and config

## Scope

The root-level configuration surface that shapes every tool a contributor invokes:
`tsconfig.json`, `tsconfig.base.json`, `tsconfig.eslint.json`, `.prettierrc.json`,
`.prettierignore`, `.eslintrc.json`, `turbo.json`, `vitest.config.ts`, `.editorconfig`,
`.env.schema`, `.mcp.json`, `.dockerignore`, `.gitignore`, `.gitattributes`, `compose.yaml`,
`Dockerfile`. Not every one of these needs to change on a given cycle; discoverability of what
each one is _for_ is itself part of DX.

## Nine-category pains this area may reveal

- **2. Confusing or unintuitive operations.** Two prettier configs at the root that disagreed
  is the historic example — the second one silently overrode the first, contributors could
  not predict which formatter setting won.
- **8. Setup/build/test/hook/lint/agent-config friction.** `turbo.json` `inputs` that
  reference nonexistent paths silently disable caching for that task and slow the whole build.
  This repo already had this exact regression (`lint.inputs` pointed at `../../` paths).
- **9. Documentation-vs-reality mismatch.** `AGENTS.md`, `CONTRIBUTING.md`, and
  `docs/architecture.md` describe the intended tooling; if actual root config drifts, the
  described build is not the executed build.

## Repo-specific anchors to check

- **Exactly one Prettier config** at the root: `.prettierrc.json`. Enforced by
  `test/unit/documentation/dx-docs.test.ts` (`keeps exactly one Prettier configuration at the
repo root`) via `duplicateFormatConfigCount`.
- **No dangling `turbo.json` inputs**. Enforced by the same test file
  (`leaves no dangling input path in turbo.json`) via `danglingTurboInputs`.
- **`.env.schema` is the source of truth** for application env vars per AGENTS.md, marked
  `@sensitive` where credentials, and enforced via Varlock (`pnpm secrets:check`).
- **TypeScript config layering** — `tsconfig.base.json` shared, `tsconfig.json` for builds,
  `tsconfig.eslint.json` for lint/typecheck. Adding a fourth without a reason is surface
  growth; deleting one that is referenced by `pnpm typecheck` or `pnpm lint` breaks the gate.
- **`.editorconfig`** is present and should stay consistent with `.prettierrc.json` so IDE
  auto-format and `pnpm format` do not fight each other.

## Supporting numeric signals from `src/experience/dev-experience.ts`

- `duplicateFormatConfigCount` — must be exactly `1`.
- `danglingTurboInputs` — must be an empty array.

## Likely evidence shape for a change in this area

1. Human-readable description of the specific root-config change (which file, which key,
   why), and which of the nine pains it removes.
2. Updates to any prose that named the old config surface (`AGENTS.md`,
   `docs/architecture.md`, `CONTRIBUTING.md`), in the same commit.
3. Regenerated Squad mirror via `pnpm squad:build` **only if** the change touches
   `squad.config.ts` or its inputs — never hand-edit `.github/skills/*`.
4. Green `test/unit/documentation/dx-docs.test.ts` proving the two numeric supporting signals
   still hold their expected values.

Prefer **deletion or consolidation** over adding a new root config file. Widening the root
config surface for a supporting-signal cosmetic win violates the Rubber-Duck gate
([../rubber-duck.md](../rubber-duck.md)).
