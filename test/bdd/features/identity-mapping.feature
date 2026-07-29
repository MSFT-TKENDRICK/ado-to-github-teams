@automated @identity
Feature: Enterprise identity mapping
  Only verified, active Entra identities with one active GitHub Enterprise account are eligible.

  # EMU lifecycle and profile data are controlled by the identity provider.
  # https://docs.github.com/en/enterprise-cloud@latest/admin/concepts/identity-and-access-management/enterprise-managed-users
  # Microsoft Graph user properties include accountEnabled and userType.
  # https://learn.microsoft.com/en-us/graph/api/resources/user

  Scenario: An active Entra member maps to one GitHub managed user
    Given a standard team migration
    When the migration is run in dry-run mode
    Then 1 member is eligible for migration
    And no identity edge case is reported

  Scenario Outline: An ineligible identity is excluded with an actionable reason
    Given the source member is "<condition>"
    When the migration is run in dry-run mode
    Then 0 members are eligible for migration
    And the identity edge case "<reason>" is reported

    Examples:
      | condition                    | reason              |
      | an Entra guest               | guest-user          |
      | disabled in Entra            | disabled-account    |
      | unresolved in Entra          | unresolved-identity |
      | missing a valid email or UPN | missing-email       |
      | missing a GitHub EMU account | no-ghemu-account    |
      | ambiguous on GitHub          | ambiguous-match     |
      | suspended on GitHub          | suspended-account   |
      | an ADO project role          | ado-project-role    |
      | a non-user service identity  | entra-role-only     |
