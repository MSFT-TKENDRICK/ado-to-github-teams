@automated @groups
Feature: Complete group and large-scope mapping
  Nested membership and scale controls must preserve distinct source cardinality.

  # Graph transitive membership is flat, paged, and may expose limited objects.
  # https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers
  # ADO team and member collection APIs use explicit pagination.
  # https://learn.microsoft.com/en-us/rest/api/azure/devops/core/teams/get-team-members-with-extended-properties

  Scenario: An ADO group resolves to its Entra origin before transitive expansion
    Given a source team contains an Entra-backed ADO group
    When the migration is run in dry-run mode
    Then the ADO group origin is expanded transitively
    And the nested member is eligible for migration

  Scenario: A direct and nested occurrence of one user produces one assignment
    Given a source team contains the same user directly and through an Entra group
    When the migration is applied with both destructive approvals
    Then the member approval count is 1
    And exactly 1 member write is attempted

  Scenario: Mapping reads honor configured bounded concurrency
    Given 6 source teams are read with concurrency 2
    When the migration is run in dry-run mode
    Then all 6 source teams are reported
    And no more than 2 team-member reads overlap

  Scenario: An empty source team remains a reviewable team mapping
    Given an empty source team
    When the migration is run in dry-run mode
    Then the dry-run report contains 1 team and 0 mapped members
