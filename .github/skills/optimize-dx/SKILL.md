---
name: "optimize-dx"
description: "Critique the full contributor-to-consumer CLI journey against nine pain categories, execute the affected command or artifact contract, implement one bounded surface change, refresh documentation, and stop truthfully. Numeric measurements are supporting evidence only."
domain: "developer-experience"
confidence: "high"
source: "manual"
tools:
  - name: "pnpm optimize:dx"
    description: "Rotate through the fifteen-area DX catalog (default 15 iterations; --iterations <n> in [1,20] to override). Prints each area, checklist, falsifiable prediction, and relevant supporting signals."
    when: "Contributor tooling, CLI naming/install, packaging, release/versioning, deployment surfaces, git hooks, workspace layout, onboarding, or documentation changes."
  - name: "pnpm test:unit"
    description: "Fail-closed drift gate covering the retired-name guard, documented-script contract, and supporting signals."
    when: "Before pushing changes that touch package.json scripts, README quick start, CONTRIBUTING common commands, lefthook.yml, prettier config, or turbo.json."
---

# Optimize developer experience

- Primary deliverable is a qualitative critique against nine pain categories: developer pains and frustration, unintuitive operations, discoverability failures, unnecessary steps, poor/missing feedback and error messages, slow iteration loops, debugging friction, setup/build/test/hook/lint/agent-config friction, and documentation-vs-reality mismatch.
- Review the full journey: clone/install -> build/change -> package -> consumer install -> invoke/configure -> deploy/consume -> diagnose/update. Theo follows developer-facing consequences across architecture and release boundaries without becoming their decision authority.
- Evidence requires a concise human-readable description, synchronized README/CONTRIBUTING/docs/AGENTS/skill documentation, and execution of the affected shipped command or public artifact contract. Documentation-only proof cannot accept a CLI, package, release, or deployment-surface change.
- The five deterministic signals in src/experience/dev-experience.ts (script count, documented-script coverage, hook enforcement, Prettier config surface, dangling turbo.json inputs) remain valid as supporting signals only, never as the definition of acceptance.
- Hook enforcement is "enforced" only when both lefthook.yml and the lefthook devDependency are present. Either alone is fail-open.
- Never widen the script surface, config surface, hook surface, or agent-touching skill footprint to make a supporting signal look better; prefer deletion or documentation.
- The drift gate is test/unit/documentation/dx-docs.test.ts. `pnpm optimize:dx` rotates through the fifteen-area catalog at skills/optimize-dx/references/areas/INDEX.md, including CLI naming/invocation, packaging/distribution, release/versioning, and build/package/deploy. Default: 15 iterations so every area is visited; `--iterations <n>` accepts 1 through 20.
- `runStatus: 'completed'` from the driver reports only that the requested passes finished without error AND that the write-ahead persona bus recorded a persona-authentic intent/outcome pair for every iteration; it never claims DX converged. Convergence/stopped/blocked are qualitative judgments Theo records in the commit/PR body per skills/optimize-dx/references/qualitative-evidence.md.
- Every iteration runs through the shared write-ahead bus `AgentBusTag` (src/experience/agent-bus.ts). Theo records a persona-authentic `expectedObservation` for the area BEFORE the supporting signal is read (`runWithIntent` structurally enforces that ordering), then records the actual observation with a bounded desirability/degree. Live output appends to a run-scoped file under `reports/agent-bus/optimize-dx/cli-contributor-engineer/` (already gitignored). The driver fails closed on any bus append failure — no silent skip. Bus success is not DX success.
- Never bypass lefthook (--no-verify, LEFTHOOK=0, SKIP=...) — bypassing invalidates every hook-enforcement signal and every claim this skill makes about hook safety.
- Review ownership: only `cli-contributor-engineer` (Theo) conducts DX review and records acceptance. A rubber-duck specialist may adversarially challenge the change, and other agents may perform mechanical implementation or security/privacy checks, but Theo must validate their claims and remains the sole DX authority.
