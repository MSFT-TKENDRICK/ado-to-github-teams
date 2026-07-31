# Release and versioning

Review the automated path from merged change to consumer update.

- Is one automation path responsible for version changes across every version-bearing manifest?
- Do all versions satisfy the repository's pre-1.0 policy without an accidental stable `1.x`
  release or undocumented SemVer-suffix scheme?
- Does publication use the documented preview dist-tag, public access, provenance, and trusted
  identity rather than a long-lived token?
- Are GitHub release classification and npm version semantics tested as separate contracts?
- Can a consumer discover the update channel and understand whether upgrades are compatible?

**Required evidence:** run the release-policy tests and inspect the workflow/config fields they
lock. A workflow file merely existing is not evidence that its version and channel contract agrees.
