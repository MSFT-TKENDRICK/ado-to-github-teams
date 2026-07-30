# Safety and delivery

## Product and data safety

- Preserve dry-run as the default. Before any destructive repository, organization, identity,
  membership, or provider write, present the exact change and obtain fresh explicit approval.
- Record approval before the first write and preserve checkpoint/idempotency invariants.
- Do not make automatic production source edits without scoped evidence and an agent-reviewed
  selected candidate.
- Keep retries finite and bounded. Never repeat an unverified destructive operation.
- Never commit credentials, tokens, tenant identifiers, generated reports, JSONL traces, Cucumber
  output, checkpoints, receipts, build output, or coverage.
- Treat reports and traces as potentially sensitive even though they should contain synthetic data.
  Stop if tenant data or a secret appears.

## Documentation freshness gate

Every cycle must keep these synchronized with behavior:

- root README usage and scheduled invocation;
- operator and security guidance;
- executable optimizer and CLI help/examples;
- command, flag, entrypoint, conflict, and persona coverage manifests/counts;
- report/receipt schemas and exit behavior;
- production experiment baseline and source evidence.

The executable docs gate checks required script/help/schema/count tokens. Agent review must cover
semantic accuracy that a token assertion cannot prove. Stale docs block completion.

## Branch and PR topology

Use one app-owned session/branch/PR per reviewable layer. This optimizer skill is a standalone
change and must target current `main` with one non-draft app-native PR.

If future work has genuinely dependent layers:

1. create app-native PRs bottom-to-top;
2. target each PR at its immediate predecessor;
3. verify every head/base SHA and required check;
4. register only with native GitHub Stacks REST metadata after strict preflight;
5. never merge stack members with per-PR merge;
6. merge only with official noninteractive `gh stack merge <stack-number> --yes --squash` after every
   member is ready.

Standalone changes remain standalone and must not receive stack metadata.

## Review and merge readiness

Before push, run focused tests after each coherent change and the full `pnpm check` gate. Resolve
review comments, required CI, merge conflicts, and stale approvals without force-pushing reviewed
work. Record PR URL/state and exact head/base SHA in the final cycle receipt and handoff.

Do not merge automatically merely because local validation passes. Follow repository review and
approval requirements.

