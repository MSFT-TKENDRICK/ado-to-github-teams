# Packaging and distribution

Review how a consumer obtains and executes the CLI outside the repository.

- Does the documented install command use the public package name and intended dist-tag?
- Do package `name`, `bin`, `files`, repository, access, and runtime engine metadata agree?
- Does `npm pack --dry-run` contain every runtime entrypoint and required asset while excluding
  source-only, generated-report, credential, and tenant-data files?
- Does the executable work from the staged tarball contract, not only through `pnpm dev`?
- Are compatibility aliases explicit and tested without obscuring the primary command?

**Required evidence:** inspect a dry-run tarball manifest and invoke its built CLI. Documentation
coverage ratios cannot substitute for package contents.
