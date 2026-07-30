---
name: "persona-evidence-loop"
description: "Run and interpret the repository persona experiment without overstating evidence."
domain: "cli-user-experience"
confidence: "high"
source: "manual"
tools:
  - name: "pnpm experiment:personas"
    description: "Generate bounded persona evidence from BDD and modeled CLI journeys."
    when: "CLI behavior or persona assumptions change."
---

# Persona evidence loop

- Treat `src/experience/personas.ts` as the shared source for Squad identities and experiment data.
- Run `pnpm experiment:personas` after changing commands, flags, conflicts, journeys, or modeled
  experience levers.
- Require complete command, flag, entrypoint, conflict, and persona coverage.
- Validate every JSONL trace against the repository schema.
- A bounded run generates hypotheses; it does not prove real-user outcomes or convergence.
- Pair the primary persona with at least one contrasting persona for cross-cutting CLI changes.
