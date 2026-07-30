---
name: "effect-architecture-boundaries"
description: "Preserve Effect-based domain and adapter boundaries in implementation work."
domain: "software-architecture"
confidence: "high"
source: "manual"
---

# Effect architecture boundaries

- Model domain and orchestration behavior with Effect.
- External capabilities are Context.Tag services with live and deterministic test Layers.
- Decode inputs and persisted data with Schemas.
- Represent expected failures as typed tagged errors.
- Keep SDKs, filesystems, processes, clocks, randomness, and networks behind adapters.
- Translate external errors at the adapter boundary; do not add broad catches or silent fallbacks.
