# Packaging and distribution

Review how a consumer obtains and executes the CLI outside the repository.

- Does the documented install command use the public package name and intended dist-tag?
- Does that registry dist-tag resolve, and can a clean consumer complete installation with one
  install command and one verification command?
- If publication is missing or broken, does the review block rather than presenting clone,
  package-manager bootstrap, build, or link steps as consumer installation?
- Do package `name`, `bin`, `files`, repository, access, and runtime engine metadata agree?
- Does `npm pack --dry-run` contain every runtime entrypoint and required asset while excluding
  source-only, generated-report, credential, and tenant-data files?
- Does the executable work from the staged tarball contract, not only through `pnpm dev`?
- Are compatibility aliases explicit and tested without obscuring the primary command?

**Required evidence:** inspect a dry-run tarball manifest, invoke its built CLI, resolve the public
registry dist-tag, and execute the post-publish clean-consumer install. Documentation coverage,
source checkout execution, or a locally linked package cannot substitute for registry availability.
