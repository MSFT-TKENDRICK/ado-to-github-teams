@tui @synthetic
Feature: Responsive terminal migration progress
  Migration operators need live progress that stays stable, truthful, and accessible
  across terminal capabilities and viewport changes.

  Background:
    Given an executed happy-path sandbox TUI migration

  Scenario: Contributor sandbox drives the production presentation sequence
    When the executed sandbox progress sequence is inspected
    Then the sandbox TUI follows the production dry-run progress sequence
    And the sandbox TUI explicitly promises no provider writes

  Scenario: Sandbox prompt persists across completed scenarios
    Given two sandbox scenarios and an explicit exit are selected
    When the interactive sandbox session is run
    Then both scenarios use production command delegation
    And the sandbox prompt remains active until the explicit exit

  Scenario: Top-level sandbox scenario remains an interactive default
    Given the top-level happy-path sandbox command is requested
    When the interactive sandbox session is run
    Then happy-path is only the first sandbox prompt default
    And no sandbox scenario runs without operator selection

  Scenario: Live progress remains stable across animated redraws
    When consecutive live TUI frames are rendered
    Then the TUI frame height remains stable
    And the TUI progress is explicitly indeterminate
    And the TUI communicates safety, current stage, and next action

  Scenario: Resize preserves bounded responsive layouts
    When the TUI is rendered at wide, standard, narrow, and minimal widths
    Then every TUI frame fits its viewport
    And the narrow TUI preserves the dry-run safety mode

  Scenario: Plain output receives deduplicated live progress
    When TUI progress is rendered for a non-interactive terminal
    Then each changed TUI progress event is emitted once
    And the plain progress output contains no cursor controls

  Scenario: Reduced motion keeps semantic progress
    When the TUI is rendered with reduced motion
    Then the TUI uses a static progress marker
    And the TUI still communicates live status

  Scenario: Untrusted provider text cannot alter the frame
    When the TUI receives multiline and terminal-control provider text
    Then the TUI frame contains no injected physical line or control sequence

  Scenario: Dashboard teardown restores the terminal
    When the interactive TUI dashboard starts and stops
    Then the alternate screen and cursor are restored
