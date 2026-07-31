---
name: optimize-tui
description: Use this skill when an agent must design, implement, validate, or review a terminal user interface; capture reproducible terminal screenshots or animations; package PNG, GIF, or MP4 evidence; iterate with advanced terminal, design, accessibility, and reliability personas; or publish visual evidence to a pull request. Activate for TUI, terminal dashboard, animated CLI, alternate screen, resize/redraw jitter, terminal evidence, or visual PR review work.
license: MIT
compatibility: Requires this repository, Git, GitHub CLI authentication for PR publishing, pnpm, Python with Pillow for evidence capture, a Chromium browser, and ffmpeg only when MP4 output is needed.
metadata:
  author: MSFT-TKENDRICK
  version: '0.1.0'
---

# Optimize TUI

Use the production renderer and synthetic scenarios as the source of truth. A TUI change is not
complete until behavior, visual evidence, and pull-request review material agree.

## Route the task

Read only the reference needed for the current phase:

- Read [iterative workflow](references/workflow.md) for every new or resumed TUI change.
- Read [evidence and media](references/evidence-and-media.md) before capturing, compressing, or
  selecting PNG, GIF, or MP4 assets.
- Read [quality and convergence](references/quality-and-convergence.md) before accepting a visual
  iteration or completing adversarial review.
- Read [pull-request evidence](references/pull-request-evidence.md) before committing assets,
  uploading media, or updating a pull request.

## Required behavior

1. Capture a source-bound baseline before editing.
2. Update production behavior, focused tests, Gherkin scenarios, and persona expectations together.
3. Regenerate deterministic synthetic evidence after each material visual iteration.
4. Inspect every state and animation; continue until persona, designer, accessibility, and adversarial
   review have no unresolved material finding.
5. Run focused gates, `npm run test:bdd`, `npm run optimize:ux -- cycle` when modeled journeys
   changed, and `npm run check`.
6. Commit the latest reviewable evidence and update the pull request so reviewers need not run the CLI.

## Non-negotiable safety

- Never put credentials, tenant data, migration reports, or non-synthetic traces in visual evidence.
- Never hide jitter, clipping, lifecycle leaks, or accessibility regressions by weakening tests.
- Never send binary media or base64 through the conversation; upload compressed files directly.
- Keep every CAPI-bound asset below 5 MiB, with a target maximum of 4.5 MiB.
