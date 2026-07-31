# Pull-request evidence

## Durable repository evidence

Update the adjacent feature document and commit the latest synthetic PNG/GIF evidence under
`test/bdd/features/evidence/tui/`. Add MP4 only when it materially improves review and remains within
repository and payload limits. Never commit transient HTML capture pages or local baseline artifacts.

The feature document should map each scenario to its current asset and state the source SHA or the
commit that refreshed the evidence.

## Upload without using CAPI payloads

Do not paste binary data or base64 into the conversation. Upload each compressed asset directly to
GitHub's user-attachments endpoint. In PowerShell:

```powershell
$token = gh auth token
$repoId = gh repo view --json databaseId -q .databaseId
$asset = Resolve-Path test\bdd\features\evidence\tui\live-progress.gif
$name = [uri]::EscapeDataString((Split-Path $asset -Leaf))
$response = curl.exe -sS -X POST "https://uploads.github.com/user-attachments/assets?name=$name&content_type=image/gif&repository_id=$repoId" `
  -H "Content-Type: application/octet-stream" `
  -H "Accept: application/vnd.github+json" `
  -H "X-GitHub-Api-Version: 2022-11-28" `
  -H "Authorization: Bearer $token" `
  --data-binary "@$asset"
$url = ($response | ConvertFrom-Json).url
if (-not $url) { throw "GitHub attachment upload did not return a URL" }
```

Use `image/png`, `image/gif`, or `video/mp4` to match the file. Never print the token. Verify the
returned URL resolves before editing the pull request.

## PR evidence section

Add or refresh a section with:

- why the TUI changed;
- a compact state-to-asset table;
- before/after assets when comparison materially helps;
- the animation or MP4 for live behavior;
- exact focused, BDD, evidence, persona, and full-gate commands;
- source/base/head SHAs;
- persona and adversarial verdicts;
- any remaining non-blocking friction.

Use uploaded attachment URLs in the PR body, not local paths or base64. Keep repository-relative links
in the feature document.

When available, use the app-native pull-request update tool. Otherwise update through GitHub's REST
API rather than a GraphQL-based editor:

```bash
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH --input pr-body.json
```

Preserve the repository PR template and unrelated human-authored sections. Replace stale evidence
links instead of appending another "latest" section.

## Final verification

Before reporting readiness:

1. open every committed and uploaded asset;
2. confirm each link shows the intended current state;
3. confirm no file exceeds 5 MiB;
4. confirm the PR lists exact passing commands and current SHAs;
5. confirm required CI passes and mergeability is clean;
6. do not merge or enable auto-merge unless the user explicitly authorized it.
