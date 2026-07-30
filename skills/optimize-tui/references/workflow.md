# Iterative TUI workflow

## Preconditions

1. Work only in the current app-owned worktree and task branch.
2. Record the current source SHA, base SHA, terminal dimensions, environment toggles, and existing PR.
3. Inspect the production renderer, its lifecycle owner, focused tests, adjacent Gherkin feature, and
   committed evidence. Do not design against a mock that bypasses production rendering.
4. Preserve unrelated work and establish whether the change affects interactive, non-TTY, CI,
   reduced-motion, screen-reader, or resize behavior.

## Establish the baseline

Run the existing focused tests and evidence pipeline before edits:

```bash
pnpm vitest run test/unit/ui/terminal-dashboard.test.ts
pnpm test:bdd
pnpm tui:evidence
```

Keep baseline captures local unless the feature document explicitly preserves before/after evidence.
Record what is wrong using observable terms: clipping, unstable height, stale frame, redraw count,
cursor state, signal listener count, missing status, inaccessible motion, or unclear next action.

## Define the review matrix

Map each changed behavior to:

- a Gherkin scenario;
- a deterministic frame or animation;
- a focused assertion;
- one or more review personas.

Always include:

- an advanced agentic terminal operator familiar with Claude Code CLI and Grok Build;
- an enterprise TUI designer;
- a screen-reader or line-oriented operator;
- an adversarial terminal reliability reviewer.

Cover live progress, wide/standard/narrow/minimal resize, blocked, failure, completion, reduced motion,
plain output, untrusted text, startup failure, teardown, restart, and signal cleanup when relevant.

## Implement in bounded iterations

For each material iteration:

1. Change the smallest coherent production surface.
2. Add or update tests without loosening lifecycle, frame-bound, or cleanup assertions.
3. Update the adjacent Gherkin scenario and synthetic evidence state.
4. Run focused tests and `pnpm tui:evidence`.
5. Inspect static and animated output at actual pixel size.
6. Record persona findings and either fix them or state why they are non-blocking and out of scope.

Prefer synchronized whole-frame redraw, one lifecycle owner, stable frame dimensions, bounded refresh
rates, debounced resize recomposition, Unicode cell-width accounting, sanitized provider text,
deduplicated plain output, and explicit text labels that do not depend on color.

Do not stop at a visually plausible frame. Test enter-write failure, render failure, teardown failure,
resize storms, repeated start/stop, non-TTY execution, `CI`, `NO_TUI`, `REDUCE_MOTION`, and
`SCREEN_READER` behavior whenever the affected code can reach those paths.

## Finish

Follow [quality and convergence](quality-and-convergence.md), then
[pull-request evidence](pull-request-evidence.md). Generated HTML capture pages are transient;
reviewable media and feature documentation are durable.
