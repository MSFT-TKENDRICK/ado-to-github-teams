---
name: "optimize-dx"
description: "Qualitatively critique this repository developer experience against nine pain categories, implement one bounded surface change, refresh the affected contributor documentation, and stop truthfully. Numeric measurements are supporting evidence only."
domain: "developer-experience"
confidence: "high"
source: "manual"
tools:
  - name: "pnpm optimize:dx"
    description: "Rotate through the eleven-area DX catalog (default 8 iterations; --iterations <n> in [1,20] to override). Prints the area under review, its checklist reference, and any relevant supporting signals from src/experience/dev-experience.ts."
    when: "Contributor tooling, git hooks, script surface, Prettier/turbo configuration, workspace layout, onboarding, or documentation changes."
  - name: "pnpm test:unit"
    description: "Fail-closed drift gate covering the retired-name guard, documented-script contract, and supporting signals."
    when: "Before pushing changes that touch package.json scripts, README quick start, CONTRIBUTING common commands, lefthook.yml, prettier config, or turbo.json."
---

# Optimize developer experience

- Primary deliverable is a qualitative critique against nine pain categories: developer pains and frustration, unintuitive operations, discoverability failures, unnecessary steps, poor/missing feedback and error messages, slow iteration loops, debugging friction, setup/build/test/hook/lint/agent-config friction, and documentation-vs-reality mismatch.
- Evidence for a DX improvement is primarily a concise human-readable description of the developer-facing surface change plus the corresponding README/CONTRIBUTING/docs/AGENTS/skill documentation update. Numeric friction scores and synthetic before/after timing are not required to accept a DX improvement.
- The five deterministic signals in src/experience/dev-experience.ts (script count, documented-script coverage, hook enforcement, Prettier config surface, dangling turbo.json inputs) remain valid as supporting signals only, never as the definition of acceptance.
- Hook enforcement is "enforced" only when both lefthook.yml and the lefthook devDependency are present. Either alone is fail-open.
- Never widen the script surface, config surface, hook surface, or agent-touching skill footprint to make a supporting signal look better; prefer deletion or documentation.
- The drift gate is test/unit/documentation/dx-docs.test.ts. `pnpm optimize:dx` rotates through the eleven-area catalog at skills/optimize-dx/references/areas/INDEX.md (documentation, repository structure/config, local environment/onboarding, file/folder hierarchy, projects/workspaces, packages/dependencies, developer tools, git hooks, git/GitHub CLI and extensions, devcontainers, dotfiles). Default: 8 iterations; overridable per run with `pnpm optimize:dx -- --iterations <n>` where <n> is an integer from 1 through 20.
- `runStatus: 'completed'` from the driver reports only that the requested passes finished without error AND that the write-ahead persona bus recorded a persona-authentic intent/outcome pair for every iteration; it never claims DX converged. Convergence/stopped/blocked are qualitative judgments Theo records in the commit/PR body per skills/optimize-dx/references/qualitative-evidence.md.
- Every iteration runs through the shared write-ahead bus `AgentBusTag` (src/experience/agent-bus.ts). Theo records a persona-authentic `expectedObservation` for the area BEFORE the supporting signal is read (`runWithIntent` structurally enforces that ordering), then records the actual observation with a bounded desirability/degree. Live output appends to `reports/agent-bus/optimize-dx/cli-contributor-engineer.jsonl` (already gitignored). The driver fails closed on any bus append failure — no silent skip. Bus success is not DX success.
- Never bypass lefthook (--no-verify, LEFTHOOK=0, SKIP=...) — bypassing invalidates every hook-enforcement signal and every claim this skill makes about hook safety.
- Review ownership: only `cli-contributor-engineer` (Theo) conducts DX review and records acceptance. Other agents may perform mechanical implementation or security/privacy checks on DX changes, but their assessments are not DX review evidence.
