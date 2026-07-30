# Evidence and convergence

## Exact artifact gate

Every cycle executes `pnpm experiment:personas` against the production baseline and writes a unique
ignored evidence directory. `optimizer-run.json` binds the run ID, branch, source SHA, current-main
base SHA, worktree fingerprint, and complete experiment configuration.

The repository-owned validator fails closed unless all checks pass:

- the report has the exact recomputed shape and values for the current baseline, personas,
  alternatives, sources, coverage, optimization decisions, rankings, and completion;
- the number of `cucumber-<iteration>.ndjson` files exactly matches the configured/report count;
- every Cucumber line is valid JSON with one supported envelope and produces scenario observations;
- every iteration is recomputed from its own Cucumber observations plus the current CLI journey
  catalog, including metrics and traces;
- every JSONL line has the exact trace key/value schema;
- a normalized multiset comparison finds no missing, unexpected, or duplicated report/JSONL trace;
- `cli-coverage.json` and `persona-experiment.md` exactly match recomputed output;
- source SHA, base SHA, branch, worktree fingerprint, and config are still live.

Malformed records, unexpected artifacts, stale baselines, changed source, incomplete coverage, or a
baseline other than `production` invalidate the cycle. Do not use invalid numbers in a summary.

## Ranking

Only unaddressed production-baseline levers below full implementation are candidates. The workflow
scans bounded merged-main and open-PR diffs, titles, bodies, and checkpoint decisions, then requires
agent review of semantic representation. Rank candidates by:

1. high-harm action count, descending;
2. P95 friction, descending;
3. unintuitive action count, descending;
4. lever name for deterministic ties.

Above-threshold means at least one high-harm action, P95 at or above the configured pain threshold,
or at least one unintuitive action. Expected opportunity and trace count are evidence, not excuses
to ignore harm.

## Metric comparison

Compare the prior cycle's production iteration with the latest fresh production iteration. A
measurable improvement reduces high-harm actions, P95 friction, unintuitive actions, or mean
friction without increasing high-harm actions. Never trade more high-harm actions for a better
secondary metric.

A defensible no-change result must explain why a scoped behavior improvement is outside the modeled
opportunity while focused tests prove it. Repeated no-change or repeated candidate sets trigger an
anti-loop blocker instead of a success result.

## Truthful stop conditions

Convergence is allowed only when:

- no unaddressed candidate remains above the modeled usability threshold; or
- every feasible candidate has zero/insufficient expected opportunity and a fresh rerun confirms no
  measurable movement with a defensible no-change explanation.

`iteration-bound-reached-with-candidates` is bound exhaustion, not convergence. Record it separately
with the remaining ranked candidates and continue.

Stop without convergence for explicit user stop, invalid evidence, stale source/baseline, stale
docs, high-harm regression, repeated candidate/no-progress cycles, incompatible checkpoint, CI
failure, merge conflict, ambiguous approval/scope, or another real blocker.

## Cycle receipt

Each durable cycle receipt records:

- run identity and timestamps;
- source SHA, current-main base SHA, branch, and worktree fingerprint;
- baseline identity/source and artifact validation counts;
- selected/deferred items, complexity, and budget;
- addressed and represented changes;
- code/docs changed and validations;
- previous production, latest production, and modeled-final metrics;
- failures, malformed traces, PR/stack state, and inspected diffs;
- remaining ranked frictions, report bound state, convergence reason;
- evidence path, next wakeup, and resume checkpoint.

Receipts and checkpoint history are local generated evidence, not committed documentation.

