---
name: persona-ux-optimizer
description: Use this skill when an agent must repeatedly run the repository's persona UX experiment, validate its evidence exactly, rank unaddressed production friction, implement bounded usability fixes, measure whether they helped, and stop truthfully at convergence, user stop, or a real blocker. Activate for persona experiment optimization, friction reduction, usability iteration, or scheduled UX improvement work in this repository.
license: MIT
compatibility: Requires this repository, Git, GitHub CLI authentication, pnpm, Node.js supported by package.json, and an app-owned Git worktree/session.
metadata:
  author: MSFT-TKENDRICK
  version: "0.1.0"
---

# Optimize persona UX

Operate only in the current app-owned worktree and its one branch/PR. Never use stale metrics from
another branch or checkout as production evidence.

## Route the task

- Read [workflow](references/workflow.md) for every new or resumed cycle.
- Read [evidence and convergence](references/evidence-and-convergence.md) before interpreting metrics,
  selecting fixes, or stopping.
- Read [safety and delivery](references/safety-and-delivery.md) before edits, destructive operations,
  scheduling, commits, PRs, stacks, or merges.

## Start or resume

```bash
pnpm persona:optimize -- cycle
```

The command runs `pnpm experiment:personas`, exact-validates configured Cucumber and JSONL evidence,
discovers current main/session/PR diffs, persists a checkpoint and cycle receipt, and returns a
ranked 6-point plan. Treat any nonzero exit as blocked, never as partial success.

## Required agent behavior

1. Inspect the receipt and source-backed diffs; confirm selected candidates are unaddressed.
2. Fully implement only the selected 1-10 fixes while preserving user/agent work.
3. Run focused validation, refresh every affected document and executable example, then rerun
   `pnpm persona:optimize -- cycle --validation "COMMAND=passed"`.
4. Continue while the receipt says `continue`. Resume from `.persona-ux-optimizer/checkpoint.json`
   on later invocations or hourly wakeups.
5. Stop only for receipt status `converged`, `stopped`, or `blocked`; report its exact reason.

## Non-negotiable safety

- Dry-run behavior remains the default. Obtain explicit approval before destructive writes.
- Do not edit production source automatically without scoped, fresh evidence.
- Do not commit generated reports, traces, checkpoints, receipts, credentials, or tenant data.
- High-harm regressions, invalid evidence, stale docs, stale source, and repeated no-progress cycles
  block completion.
- Never claim convergence because an experiment iteration bound was reached.

