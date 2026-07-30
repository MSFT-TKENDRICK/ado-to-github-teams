# Quality and convergence

## Required gates

Run the smallest focused tests after every coherent change. Before delivery, run:

```bash
pnpm vitest run test/unit/ui/terminal-dashboard.test.ts
pnpm test:bdd
pnpm tui:evidence
pnpm check
```

If commands, flags, conflicts, personas, journeys, or modeled experience levers changed, also run:

```bash
pnpm optimize:ux -- cycle
```

Exact-validate every configured iteration, Cucumber record, and JSONL trace. Treat malformed evidence,
stale source, missing coverage, or a nonzero command exit as blocked rather than partial success.

## Persona and designer pass

Review the refreshed evidence in this order:

1. advanced operator: information density, live progress, stable redraw, resize, and escape to plain
   output;
2. enterprise designer: hierarchy, semantic status, restrained motion, responsive density, and
   corporate clarity;
3. nonvisual operator: line-oriented output, no cursor controls, text redundancy, and reduced motion;
4. reliability reviewer: alternate-screen restoration, signal ownership, restart, injection, frame
   bounds, and exception paths.

Each finding must cite an asset, frame, scenario, or failing assertion. Resolve it, record a scoped
deferral, or mark the iteration blocked.

## Adversarial rubber-duck gate

After the persona pass, ask a rubber-duck reviewer to try to disprove readiness:

```text
Act as an adversarial TUI reviewer. Find concrete lifecycle, redraw, resize, accessibility, evidence,
CI, and pull-request-review failures. Test emit-then-throw startup, render failure, throwing teardown,
listener leaks, alternate-screen restoration, repeated start/stop, resize storms, non-TTY/CI paths,
reduced motion, screen-reader output, control-sequence injection, Unicode width, stale evidence, and
assets over the upload limit. Report only reproducible findings with file:line or artifact evidence.
Return READY only when no blocking issue remains.
```

After fixes, rerun the same reviewer with the new source SHA and exact diff. Continue until it returns
READY with no blocking finding. Do not treat an iteration bound, reviewer silence, or a green static
screenshot as convergence.

## Stop conditions

Ready means all of the following are true:

- focused, BDD, and full repository gates pass;
- deterministic evidence is current and visually inspected;
- persona and designer feedback has no unresolved material finding;
- adversarial review returns READY;
- the feature document and pull request show the same latest assets and commands;
- required CI is passing and the pull request is mergeable.

Stop without claiming readiness for a real test failure, stale or malformed evidence, upload limit
violation, unresolved blocking finding, merge conflict, ambiguous scope, or missing approval.
