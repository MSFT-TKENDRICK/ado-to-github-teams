# Adversarial rubber-duck mode

Load this reference only after exact evidence produces a bounded candidate plan.

## Run the specialist

Launch the `rubber-duck` agent with the latest receipt, selected/deferred candidates, source/base
SHAs, represented diffs, proposed files, and safety constraints. Ask it to attack the plan, not
rewrite prose:

```text
Act as an adversarial rubber duck. Try to disprove that these candidates are unaddressed, correctly
ranked, feasible within six points, and safe. Look for stale or circular evidence, hidden high-harm
regressions, metric gaming, overlap with merged/open work, missing users or journeys, destructive
side effects, incomplete docs/tests, and a cheaper fix. Return verdict passed, revised, or blocked;
list each finding with the evidence that resolves it. Do not comment on style.
```

## Resolve findings

- `passed`: no material issue remains; implementation may begin.
- `revised`: update addressed items, complexity, selection, tests, or scope and rerun the cycle.
- `blocked`: stop. Record the blocker; do not implement or claim convergence.

Record the result on the next cycle:

```bash
npm run optimize:ux -- cycle \
  --rubber-duck-verdict revised \
  --rubber-duck-finding "Open auth diagnostics work already represents credential readiness" \
  --addressed credentialSetup
```

Every finding needs a receipt entry and a concrete resolution. Empty assurances, generic approval,
or a rubber-duck pass based on stale source do not satisfy the gate.
