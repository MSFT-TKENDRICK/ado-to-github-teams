# TUI experience and review evidence

The migration TUI is a responsive, alternate-screen control plane for interactive sandbox and
foreground runs. It uses synchronized atomic redraw, bounded animation, resize recomposition, explicit
safety state, and a deduplicated line-oriented fallback for non-TTY, CI, reduced-motion, and
screen-reader contexts.

## Review personas

| Persona                               | Context                                                | Review focus                                                                                                |
| ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Avery, advanced agentic TUI operator  | Uses Claude Code CLI and Grok Build daily              | Live state density, elapsed progress, stable redraw, resize, shortcuts, and plain-output escape             |
| Priya, enterprise TUI designer        | Reviews corporate operational interfaces               | Hierarchy, semantic color with text redundancy, responsive density, restrained motion, and evidence quality |
| Jordan, nonvisual operator            | Uses a screen reader and line-oriented terminal output | No cursor controls, no color-only meaning, deduplicated textual updates, and reduced motion                 |
| Morgan, terminal reliability reviewer | Adversarially tests terminal behavior                  | Signal cleanup, control-sequence injection, Unicode cell width, frame bounds, and prompt compatibility      |

## Executable scenarios

The adjacent [`tui-experience.feature`](tui-experience.feature) covers:

1. the executed `happy-path` sandbox progress sequence from production orchestration;
2. stable animated frame shape and explicitly indeterminate throughput;
3. wide, standard, narrow, and minimal resize bounds;
4. deduplicated plain live progress without ANSI cursor controls;
5. reduced-motion semantic status;
6. multiline and terminal-control injection resistance; and
7. alternate-screen and cursor restoration.

## Latest production-renderer evidence

All evidence uses synthetic identifiers. `npm run tui:evidence` executes `happy-path`,
`apply-happy-path`, and `github-lookup-failure` through `runEffectMigration`, production
checkpoint/report/approval behavior, and deterministic provider Layers. The committed
[`execution-manifest.json`](evidence/tui/execution-manifest.json) maps every asset to an exact
scenario event and records the reviewed source SHA. Hand-authored renderer state cannot satisfy this
gate.

Current executable evidence source: `99d54b0a19e400d6d7cd2031d34a4a5900ed4835`.

| State                    | Executed scenario       | Evidence                                                            |
| ------------------------ | ----------------------- | ------------------------------------------------------------------- |
| Live progress animation  | `happy-path`            | ![Animated live migration progress](evidence/tui/live-progress.gif) |
| Wide live state          | `happy-path`            | ![Wide live state](evidence/tui/wide-live.png)                      |
| Standard 80-column state | `happy-path`            | ![Standard live state](evidence/tui/standard-live.png)              |
| Narrow resize edge       | `happy-path`            | ![Narrow live state](evidence/tui/narrow-live.png)                  |
| Blocking decision        | `apply-happy-path`      | ![Blocked state](evidence/tui/blocked.png)                          |
| Failure and recovery     | `github-lookup-failure` | ![Failure state](evidence/tui/failed.png)                           |
| Completion receipt       | `happy-path`            | ![Completed state](evidence/tui/complete.png)                       |
| Reduced motion           | `happy-path`            | ![Reduced-motion state](evidence/tui/reduced-motion.png)            |

## Change and pull request gate

Every TUI behavior or visual change must:

1. update the focused unit/integration tests and the adjacent Gherkin scenarios;
2. execute `npm run dev -- --sandbox happy-path`, then run `npm run test:bdd`, the focused TUI tests,
   and `npm run check`;
3. load the progressive [`optimize-tui`](../../../skills/optimize-tui/SKILL.md) workflow;
4. install Pillow once with `python -m pip install Pillow`, then run `npm run tui:evidence`;
5. fail if the manifest is stale, malformed, or lacks a mapping for any PNG/GIF;
6. review and commit the refreshed manifest and PNG/GIF evidence in `evidence/tui/`, adding an MP4 only
   when it materially clarifies longer motion and remains below the payload limit; and
7. embed the relevant committed PNG/GIF/MP4 files plus exact test commands in the pull request body so
   reviewers can evaluate the experience without running the application.

Generated migration reports, tenant data, credentials, and non-synthetic traces must never appear in
visual evidence or pull request content.
