Feature: Explore migration behavior without provider access
  Operators can run production orchestration against deterministic boundary fixtures
  so they can inspect reports, approvals, failures, retries, and simulated writes safely.

  @sandbox-happy-path
  Scenario: Preview a mapped team and member
    Given a project team with one resolvable member
    When I run the happy-path sandbox
    Then the dry-run report contains the proposed team and member

  @sandbox-group-expansion
  Scenario: Expand an Entra-backed ADO group
    Given an ADO team contains an Entra-backed group
    When I run the group-expansion sandbox
    Then the group member is mapped through the normal integration boundaries

  @sandbox-guest-user
  Scenario: Report a guest identity
    Given a team member resolves to an Entra guest
    When I run the guest-user sandbox
    Then the report identifies the guest-user edge case

  @sandbox-suspended-user
  Scenario: Report a suspended GitHub identity
    Given a mapped GitHub user is suspended
    When I run the suspended-user sandbox
    Then the report identifies the suspended-account edge case

  @sandbox-ambiguous-user
  Scenario: Report an ambiguous GitHub identity
    Given GitHub returns multiple users for one email
    When I run the ambiguous-user sandbox
    Then the report identifies the ambiguous-match edge case

  @sandbox-circular-group
  Scenario: Report a circular group
    Given Entra detects a circular group membership
    When I run the circular-group sandbox
    Then the report identifies the circular-group-member edge case

  @sandbox-nested-group-depth
  Scenario: Report a nested group depth limit
    Given Entra rejects a group beyond the supported nesting depth
    When I run the nested-group-depth sandbox
    Then the report identifies the nested-group-skipped edge case

  @sandbox-role-identities
  Scenario: Report provider-specific role identities
    Given a team contains a service role and an ADO project role
    When I run the role-identities sandbox
    Then the report identifies both roles as edge cases

  @sandbox-apply-happy-path
  Scenario: Simulate an approved apply
    Given team creation and member assignment are approved
    When I apply the apply-happy-path sandbox
    Then the transcript records create-team before add-member without provider writes

  @sandbox-sso-team-write
  Scenario: Simulate an SSO-enforced team write
    Given GitHub rejects team creation because SSO authorization is required
    When I apply the sso-team-write sandbox
    Then the operator can approve skipping the simulated write

  @sandbox-transient-team-write
  Scenario: Retry a transient team write
    Given the first simulated team creation is rate limited
    When I apply the transient-team-write sandbox
    Then the shared retry policy repeats the boundary call and succeeds

  @sandbox-github-lookup-failure
  Scenario: Surface a non-ambiguity lookup failure
    Given GitHub user search is unavailable
    When I run the github-lookup-failure sandbox
    Then the migration reaches its configured expected failure
