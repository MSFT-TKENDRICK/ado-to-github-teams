# Build, package, and deploy

Review the seam between source build, release artifact, deployment host, and runtime defaults.

- Is the supported build operating system and architecture explicit, and does CI exercise it?
- Does artifact validation assert public contracts such as non-empty registries and exported
  handlers rather than compiler-internal marker text?
- Does zero-configuration behavior remain local, with cloud use gated by sign-in, an accessible
  subscription, explicit selection, and independently configured deployed hosts?
- Are no-subscription, inaccessible-subscription, cancellation, and unsupported-host paths clear
  and fail closed without pretending deployment succeeded?
- If the artifact omits dependencies, do deployment docs state the required remote build settings
  and incompatible run-from-package mode?
- Are build, package, deploy, rollback, and diagnosis commands discoverable from contributor docs?

**Required evidence:** run focused default/failure-path tests and the artifact build on its supported
host, then inspect the generated public manifest and handlers. Prose cannot prove an executable
deployment contract.
