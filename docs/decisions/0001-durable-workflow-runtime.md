# ADR 0001: Use a pluggable durable workflow runtime

- **Status:** Accepted
- **Last reviewed:** 2026-07-31

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

Keep local as the default. The only supported cloud deployment is an optional Azure World that
combines Azure Durable Functions queue/timer orchestration with shared remote libSQL storage hosted
on Azure. Make Azure selectable only after Azure authentication succeeds, at least one enabled
subscription is visible, and the operator explicitly chooses one. A signed-in identity with no
subscription remains on local.

## Consequences

### Benefits

- CLI processes can disconnect without abandoning the migration.
- Several runs can wait independently for operator decisions.
- Progress, approvals, and failure context survive restart.
- Domain orchestration remains independent of a specific database or queue implementation.
- An Azure deployment can change the execution substrate without changing migration behavior.

### Costs and risks

- Live migrations require a worker and queue, not only the CLI process.
- SQLite and NATS have no shared transaction, so reconciliation and idempotency are mandatory.
- The supplied single-host Compose deployment is not highly available.
- Azure Functions and the migration worker require one shared remote World database; local SQLite
  cannot cross the host boundary.
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

### Remote database World as the default

Rejected because it raises the evaluation barrier and would make an Azure subscription mandatory.
Local remains the zero-configuration default; Azure is explicit opt-in.
