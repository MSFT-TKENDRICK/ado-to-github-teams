---
name: "migration-safety-invariants"
description: "Non-negotiable invariants for safe Azure DevOps to GitHub team migrations."
domain: "migration-safety"
confidence: "high"
source: "manual"
tools:
  - name: "pnpm test:integration"
    description: "Exercise approval, checkpoint, idempotency, and bounded-concurrency behavior."
    when: "Migration orchestration or destructive behavior changes."
---

# Migration safety invariants

1. Dry-run is the default.
2. Present the exact proposed change before approval.
3. Record explicit approval before the first write.
4. Persist a validated checkpoint before and after each resumable unit.
5. Flush checkpoint state on cancellation and failure.
6. Reject resume when configuration or schema versions are incompatible.
7. Make writes idempotent, bound concurrency, classify throttling, and use finite retry budgets.
8. Never retry an unverified destructive operation.

These application invariants remain authoritative even when Squad hooks or prompts are unavailable.
