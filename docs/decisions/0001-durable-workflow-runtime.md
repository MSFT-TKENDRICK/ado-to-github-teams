# ADR 0001: Use a pluggable durable workflow runtime

- **Status:** Accepted
- **Last reviewed:** 2026-07-30

## Context

Migration work crosses three providers, can run longer than one CLI process, and includes writes
that must not be repeated without verification. A process-local loop or a collection of ad hoc
checkpoint files cannot safely coordinate approval, concurrent work, interruption, replay, and
operator handoff.

The project also needs a local evaluation path and a production deployment path without coupling
domain orchestration to one storage or queue vendor.

## Decision

Run migrations as durable Workflow Development Kit workflows behind a worker API.

Use a pluggable Workflow World boundary. The repository's default local World composes:

- Turso/libSQL World storage in SQLite for workflow events, hooks, steps, and streams;
- NATS JetStream World queues for workflow and step delivery; and
- Litestream replication of SQLite to a JetStream Object Store bucket.

Persist progress before and after each resumable migration unit. Re-enqueue active runs at worker
startup and reconcile potentially stranded runs on a bounded interval. Keep migration writes
idempotent and verify uncertain destructive outcomes before retry.

Allow another World only when explicitly configured with `WORKFLOW_TARGET_WORLD` and acknowledged
with `WORKFLOW_ALLOW_REMOTE_TARGET=true`.

## Consequences

### Benefits

- CLI processes can disconnect without abandoning the migration.
- Several runs can wait independently for operator decisions.
- Progress, approvals, and failure context survive restart.
- Domain orchestration remains independent of a specific database or queue implementation.
- A production deployment can select a different World without changing migration behavior.

### Costs and risks

- Live migrations require a worker and queue, not only the CLI process.
- SQLite and NATS have no shared transaction, so reconciliation and idempotency are mandatory.
- The supplied single-host Compose deployment is not highly available.
- Co-locating the live queue and backup target does not protect against host loss; production must
  use failure-independent backup or a suitable remote World.
- Workflow state and reports contain sensitive operational data and require controlled retention.

## Alternatives considered

### Process-local execution with JSON checkpoints

Rejected because it makes cross-session coordination, durable approvals, and concurrent resume
fragile. It also encourages operators or agents to inspect and edit implementation state directly.

### Official local World only

Rejected as the default because the local World is intended for development and does not provide
the queue and recovery posture required by live migration.

### PostgreSQL World as the only deployment

Not selected as the default because it raises the evaluation barrier. It remains the recommended
direction for self-hosted, multi-host production where its operational requirements are acceptable.
