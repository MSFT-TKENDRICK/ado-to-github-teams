@manual @external-behavior
Feature: Externally owned enterprise constraints
  These scenarios are part of production readiness but require a controlled live tenant.
  The automated check-in gate reports them without claiming that mocked service ports prove them.

  # GitHub team sync and EMU membership ownership
  # https://docs.github.com/en/enterprise-cloud@latest/organizations/organizing-members-into-teams/synchronizing-a-team-with-an-identity-provider-group
  # https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/managing-team-memberships-with-identity-provider-groups

  Scenario: Direct membership writes are refused for an IdP synchronized team
    Given a target team is owned by SCIM or team synchronization
    When the migration proposes direct membership changes
    Then the operator is directed to change membership in the identity provider

  Scenario: Connecting an existing team to an IdP group cannot silently remove access
    Given an existing target team has manually managed members
    When the team is evaluated for IdP synchronization
    Then the removal impact is reviewed before synchronization

  Scenario: Hidden and limited-information Graph members fail closed
    Given Microsoft Graph omits identity fields because permissions are insufficient
    When transitive membership is enumerated
    Then the migration reports the permission gap without dropping members

  Scenario: Large and eventually consistent Graph groups are reconciled
    Given a paged Entra group changes during enumeration
    When the migration plan is produced
    Then every next link is followed and the plan is revalidated before apply

  Scenario: Unsupported synchronized group topology is rejected
    Given an Entra group is nested, is not a security group, or exceeds 5000 members
    When GitHub team synchronization is planned
    Then the unsupported topology is reported before any write

  Scenario: SSO authorization is revoked during apply
    Given a GitHub token loses SSO authorization after team creation
    When member assignment begins
    Then the checkpoint remains resumable and no unauthorized retry is treated as success

  Scenario: Every provider throttle honors its retry contract
    Given GitHub, Azure DevOps, or Microsoft Graph returns a retry-after response
    When the finite retry budget is used
    Then retries wait for the provider interval and stop at the declared limit

  Scenario: EMU accounts are provisioned only through the configured identity provider
    Given an active Entra user has no GitHub managed user account
    When the migration plan is reviewed
    Then provisioning is delegated to the supported SCIM identity provider

  Scenario: EMU identity configuration rejects unsupported provider combinations and collisions
    Given SSO and SCIM use an unsupported mixed provider configuration or normalized usernames collide
    When enterprise readiness is reviewed
    Then the migration is blocked pending identity-provider remediation

  Scenario: GitHub team hierarchy and implicit maintainers are reconciled
    Given a target team is nested, synchronized, secret, or created by an operator
    When target state is verified
    Then hierarchy restrictions and the automatically added maintainer are included in the review

  Scenario: Reports and PR summaries expose no tenant identity data or credentials
    Given a migration report contains organization and identity details
    When CI publishes the BDD summary
    Then only synthetic aggregate test results are posted to the pull request
