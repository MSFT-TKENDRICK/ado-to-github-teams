@automated @safety
Feature: Safe migration orchestration
  The migration must fail closed and preserve an audit trail around every target write.

  # GitHub API writes require explicit authorization and can be partially applied.
  # https://docs.github.com/en/rest/teams/teams
  # https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api

  Scenario: Dry run produces a reviewable plan without target writes
    Given a standard team migration
    When the migration is run in dry-run mode
    Then the migration succeeds
    And no GitHub writes are attempted
    And the dry-run report contains 1 team and 1 mapped member
    And the completed dry-run checkpoint is removed

  Scenario: Approved apply records approval before every destructive phase
    Given a standard team migration
    When the migration is applied with both destructive approvals
    Then the migration succeeds
    And team creation completes before member assignment
    And team creation approval is checkpointed before the first team write
    And member assignment approval is checkpointed before the first member write
    And the apply report contains both approvals

  Scenario: Rejected team creation fails before any target write
    Given a standard team migration
    And the operator rejects team creation
    When the migration is applied
    Then the migration fails with "Destructive team creation not approved"
    And no GitHub writes are attempted
    And the rejection is retained in the checkpoint

  Scenario: A skipped team cannot receive members
    Given a standard team migration
    And GitHub requires SSO authorization while creating the team and the operator skips that team
    When the migration is applied
    Then the migration succeeds
    And the team is reported as skipped
    And no member write is attempted for the skipped team

  Scenario: Distinct source teams cannot collapse into one target team
    Given two source teams normalize to the same GitHub slug
    When the migration is applied with both destructive approvals
    Then the migration fails with "normalize to the same GitHub slug"
    And no GitHub writes are attempted

  Scenario Outline: Resume rejects incompatible migration scope and mapping
    Given a checkpoint whose "<setting>" differs from this run
    When the checkpoint is resumed
    Then the migration fails with "is incompatible"
    And no provider operation is attempted
    And the incompatible checkpoint is not modified

    Examples:
      | setting             |
      | ADO organization    |
      | ADO project         |
      | GitHub organization |
      | prefix              |
      | suffix              |
