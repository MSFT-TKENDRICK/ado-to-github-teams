# Iterative workflow

## Preconditions

1. Confirm the current checkout is the app-owned worktree and the branch is not `main`.
2. Inspect `git status`, current `origin/main`, the current app session, open PRs, and any existing
   `.optimize-ux/checkpoint.json`. Preserve all user and agent work.
3. Use one app-owned session, branch, and standalone PR for this independent skill or fix layer.
4. Run from repository root. The optimizer fetches `origin/main`, fingerprints committed and
   uncommitted source, and fails if source changes during evidence collection.

## Start a cycle

```bash
pnpm optimize:ux -- cycle
```

Useful bounded options:

```bash
pnpm optimize:ux -- cycle --iterations 5 --pain-threshold 40
pnpm optimize:ux -- cycle --complexity credentialSetup=medium
pnpm optimize:ux -- cycle --addressed credential-readiness-preflight
pnpm optimize:ux -- status
```

Omitting `--iterations` defaults that run to `8`. Every run may explicitly choose any integer from
`1` through `20`; the receipt and `optimizer-run.json` persist the chosen value. Do not lower it
merely to finish sooner. Validation uses that run's configured/report count and rejects missing or
unexpected Cucumber files.

## Evidence -> select -> implement

1. Read `.optimize-ux/latest-receipt.json`.
2. Confirm `artifactValidation.valid` and `documentationGate.fresh` are true.
3. Review `prState.inspectedDiffs`, `representedChanges`, and live diffs. A merged/open change that
   represents a lever is addressed even if its PR is not the current branch.
4. Work down `remainingRankedFrictions`, ordered by high-harm actions, P95 friction, unintuitive
   actions, then stable lever name.
5. The command selects 1-10 above-threshold fixes within six points: small=1, medium=3, large=5.
   Reclassify with `--complexity lever=size` when source inspection disproves the default medium size.
6. Implement every selected item completely. Do not broaden scope to deferred items.

Before step 6, run [adversarial rubber duck](rubber-duck.md). Do not implement a pending or blocked
plan.

If any selected candidate changes terminal presentation, redraw, animation, resize, plain output, or
TTY lifecycle, load [Optimize TUI](../../optimize-tui/SKILL.md). Follow that skill's progressive
workflow for focused scenarios, visual evidence, convergence, and pull-request delivery rather than
duplicating its instructions here.

## Validate -> document -> rerun

Run the smallest focused tests for changed behavior. Refresh the root README, operator/security
guidance, executable CLI help and examples, coverage manifests/counts, output schemas and exit
behavior, and production experiment baseline/evidence whenever behavior changed.

Record focused gates on the fresh rerun:

```bash
pnpm optimize:ux -- cycle \
  --rubber-duck-verdict passed \
  --rubber-duck-finding "No unaddressed high-harm regression path found" \
  --validation "pnpm vitest run test/unit/example.test.ts=passed" \
  --validation "pnpm typecheck=passed"
```

If production metrics do not move, add a concrete, evidence-backed explanation:

```bash
pnpm optimize:ux -- cycle --no-change-reason "The fix prevents invalid input before the modeled action trace, so the covered successful journey is unchanged."
```

An unexplained no-change result fails closed. A high-harm increase is blocking even when P95, mean,
or unintuitive counts improve.

## Commit and continue

After a coherent cycle passes focused validation and docs freshness, commit it with the required
conventional subject and Copilot co-author trailer. Run `pnpm check` before pushing. Keep iterating
until the receipt says `converged`, a user explicitly stops, or a real blocker is recorded.

Generated reports, JSONL traces, receipts, and checkpoints remain ignored. Never stage them.

## Scheduled resume

For hourly work, attach an app session automation to the same session with a durable instruction to:

1. read the checkpoint and latest cycle receipt;
2. refresh current-main/session/PR state;
3. invoke `pnpm optimize:ux -- cycle --next-wakeup <RFC3339>`;
4. implement the selected bounded plan;
5. validate, document, commit, and rerun.

Do not create a new branch each hour. Resume the same reviewable layer until it is complete or
blocked, then stop the schedule.
