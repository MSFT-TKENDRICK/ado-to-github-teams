# ADR 0002: Require an explicit team topology plan

- **Status:** Accepted
- **Last reviewed:** 2026-07-30

## Context

Azure DevOps teams and permissions do not have a safe one-to-one translation to GitHub nested
teams and repository roles. Azure DevOps supports object-level allow and deny semantics. GitHub
repository access is additive, child teams inherit parent grants, and synchronized teams cannot be
parents or children.

Inferring a hierarchy or repository permission from a project name, team name, or Azure DevOps ACL
could broaden effective access without an operator noticing.

## Decision

Keep flat team migration as the default. Require a versioned YAML or JSON plan when an operator
wants organization-unit, project, and repository contributor teams.

The plan names:

- one structural organization-unit team;
- an optional structural project-team name;
- each target repository;
- one leaf team per repository;
- the source Azure DevOps teams whose members feed that leaf; and
- one direct GitHub repository role.

Structural teams receive no migrated members or direct repository grants. Leaf teams receive the
deduplicated selected membership and the declared grant.

Validate the complete plan before writes. Reject cross-organization repositories, duplicate
mappings, missing or archived repositories, slug collisions, incompatible existing parents,
synchronized nested teams, unsupported custom roles, permission downgrades, and grants below the
organization base permission. Require `allowAdmin: true` for an `admin` role.

Persist a digest of the topology input and reject resume when it changes.

## Consequences

### Benefits

- No repository permission is inferred from ambiguous source metadata.
- The dry run shows the exact hierarchy and direct grants.
- Structural teams cannot silently widen access through direct grants created by the migration.
- Resume cannot apply a different topology under an earlier approval.

### Costs and limitations

- Operators must author and review a topology file.
- GitHub effective access still includes organization base permission, repository visibility,
  parent grants, other teams, collaborators, deploy keys, custom roles, and enterprise policy.
- Azure DevOps deny ACLs have no GitHub equivalent and require manual review.
- IdP-synchronized teams must remain flat and have their membership managed in the identity
  provider.
- The tool creates organization teams only; cross-organization enterprise-team design remains
  outside its scope.

## Alternatives considered

### Infer topology from Azure DevOps project and team names

Rejected because naming does not prove governance boundaries or intended repository access.

### Translate Azure DevOps ACLs automatically

Rejected because deny semantics and GitHub's additive inheritance make a faithful, least-privilege
translation impossible without organization-specific policy.

### Always create the hierarchy

Rejected because many migrations need only flat teams, and synchronized teams cannot participate
in GitHub nesting.
