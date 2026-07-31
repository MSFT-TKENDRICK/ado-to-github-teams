---
name: "optimize-devx"
description: "Measure real developer-experience quantities in this repository, defend them against documentation drift, and stop truthfully when the numbers stop moving."
domain: "developer-experience"
confidence: "high"
source: "manual"
tools:
  - name: "pnpm optimize:devx"
    description: "Print the current DX measurements as a plain-text report."
    when: "Contributor tooling, git hooks, script surface, or Prettier/turbo configuration changes."
  - name: "pnpm test:unit"
    description: "Fail-closed drift gate covering the DX measurements."
    when: "Before pushing changes that touch package.json scripts, lefthook.yml, prettier config, or turbo.json."
---

# Optimize developer experience

- Compute deterministic DX measurements from src/experience/dev-experience.ts, never simulated persona friction.
- Root pnpm script count, documented-script coverage, git-hook enforcement, Prettier config surface, and turbo.json input resolvability are the only in-scope signals.
- Hook enforcement is "enforced" only when both lefthook.yml and the lefthook devDependency are present. Either alone is fail-open.
- Never widen the surface to make a number look better; prefer deletion or documentation.
- The drift gate is test/unit/documentation/devx-docs.test.ts. `pnpm optimize:devx` is the report.
- Never bypass lefthook (--no-verify, LEFTHOOK=0, SKIP=...) — bypassing invalidates every measurement.
- Review ownership: only `cli-contributor-engineer` (Theo) conducts DevEx review and records acceptance. Other agents may perform mechanical implementation or security/privacy checks on DevEx changes, but their assessments are not DevEx review evidence.
