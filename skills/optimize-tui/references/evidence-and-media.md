# Evidence and media

## Evidence contract

Every visual artifact must be:

- generated from the production renderer;
- derived from an executed sandbox scenario that traverses the production orchestrator;
- deterministic and bound to the reviewed source SHA;
- synthetic and free of credentials, tenant data, reports, or real identities;
- paired with a Gherkin scenario or documented review state;
- small enough to review and upload without crossing the 5 MiB CAPI Responses limit.

Use PNG for a stable state, GIF for a short loop where timing is the point, and MP4 for a longer
sequence such as resize, recovery, or multi-stage progress. Do not create motion merely to decorate a
static state.

## Generate repository evidence

Install the one-time capture dependency if needed:

```bash
python -m pip install Pillow
```

Render and capture the current deterministic suite:

```bash
npm run tui:evidence
```

The command writes reviewed assets beneath `test/bdd/features/evidence/tui/` and removes transient
HTML capture pages. It must also write `execution-manifest.json`, mapping every static and animated
asset to a scenario ID and event sequence. Missing, stale, malformed, or fixture-only trace metadata
fails the evidence gate. Inspect every generated file; command success does not establish visual
quality.

## Package an MP4 when it adds review value

Use ffmpeg only after the GIF or frame sequence is correct. For the existing live loop:

```bash
ffmpeg -y -i test/bdd/features/evidence/tui/live-progress.gif -an -vf "fps=12,scale='min(1200,iw)':-2:flags=lanczos" -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -movflags +faststart test/bdd/features/evidence/tui/live-progress.mp4
```

Keep the committed GIF as the portable feature-document preview. Commit an MP4 only when it shows
behavior the GIF cannot communicate clearly and repository policy permits the binary size.

## Size and payload discipline

Target each file below 4.5 MiB and require every file to remain below 5 MiB. On PowerShell:

```powershell
Get-ChildItem test\bdd\features\evidence\tui -File |
  Select-Object Name, Length |
  Sort-Object Length -Descending
```

If an asset is too large, reduce duration, frame rate, dimensions, palette, or MP4 bitrate before
upload. Never split base64 across messages, attach raw bytes to a tool response, or include multiple
large assets in one CAPI payload. Upload one compressed binary at a time through GitHub's attachment
endpoint as described in [pull-request evidence](pull-request-evidence.md).

## Visual inspection checklist

Inspect static states for:

- complete viewport fit at the declared columns and rows;
- stable hierarchy, readable contrast, and no color-only meaning;
- truthful safety mode, phase, status, elapsed state, and next action;
- a matching scenario/event entry in `execution-manifest.json`;
- sanitized provider text and no accidental control sequences.

Inspect animation for:

- no frame-height or horizontal-width oscillation;
- no cursor flash, partial frame, tearing, or accumulated output;
- restrained cadence and stable labels;
- reduced-motion equivalence;
- resize recomposition only after the debounce boundary.

Record asset name, scenario, source SHA, dimensions, byte size, and reviewer finding in the feature
document or pull-request evidence table.
