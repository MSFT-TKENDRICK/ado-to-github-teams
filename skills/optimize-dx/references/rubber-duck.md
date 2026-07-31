# Adversarial rubber duck (Theo only)

Load this reference only after a candidate DX surface change is selected.

This gate is owned solely by the `cli-contributor-engineer` persona (Theo). A rubber-duck
specialist may adversarially challenge assumptions and inspect the implementation, but Theo must
validate each finding and owns the verdict. Operator personas, Fact Checker, Scribe, Rai, and other
agents do not become DX authorities; their opinions are supporting input, not evidence acceptance.

## Steelman at least one real objection

For the current proposed change, force yourself to state and then answer at least one real
objection drawn from the nine pain categories in [workflow](workflow.md):

1. Would a contributor with a fresh clone genuinely be confused, misled, or slowed down by
   this change in any of the nine categories?
2. Is the corresponding documentation update actually in the same commit, or is it deferred
   to "the next PR"?
3. Does this change widen the script surface, config surface, hook surface, or
   agent-touching skill footprint without removing a specific pain? If yes, prefer deletion,
   consolidation, or renaming.
4. Is there a cheaper fix that removes the same pain (for example, deleting a script instead
   of documenting it, deleting a duplicate config instead of consolidating two)?
5. Would this change relax a safety invariant in [safety and delivery](safety-and-delivery.md)
   for developer convenience?
6. Did the review follow the whole affected path — package name and install command, shipped
   executable and help, configuration defaults and failure paths, artifact contents, deployment
   requirements, and upgrade channel — or stop at repository documentation?
7. Can the evidence be gamed by a count, allowlist, generated report, or self-excusing prediction
   while the real command remains confusing or broken?
8. Does an assertion target a public contract (manifest, exported handler, CLI output) or a brittle
   implementation marker that can reject a valid artifact?

## Verdict

- `passed`: at least one real objection was steelmanned and answered with the specific
  surface state that resolves it. Implementation may complete.
- `revised`: an objection revealed the change is not the smallest fix, is not the right
  category, or is missing its documentation update. Update the plan and re-review.
- `blocked`: an objection revealed a real regression, a required doc mismatch, or a safety
  concern. Stop and record it explicitly in the pull request body.

Empty assurances, generic approval, or a rubber-duck pass with no stated objection do not
satisfy this gate.
