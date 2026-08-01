export interface OutcomeConfirmation {
  readonly title: string
  readonly reference: string
  readonly result: string
  readonly record: string
  readonly nextStep: string
  readonly nextCommands: ReadonlyArray<string>
}

export interface MigrationCompletion {
  readonly runId: string
  readonly reportPath: string
  readonly apply: boolean
  readonly nextCommands?: ReadonlyArray<string>
  readonly sandboxScenario?: string
}

export function renderOutcomeConfirmation(
  confirmation: OutcomeConfirmation,
): ReadonlyArray<string> {
  return [
    confirmation.title,
    `Reference: ${confirmation.reference}`,
    `Result: ${confirmation.result}`,
    `Record: ${confirmation.record}`,
    `Next step: ${confirmation.nextStep}`,
    'Next commands:',
    ...confirmation.nextCommands.map((command) => `  ${command}`),
  ]
}

export function renderMigrationCompletion(completion: MigrationCompletion): ReadonlyArray<string> {
  const sandbox = completion.sandboxScenario !== undefined
  const nextCommands = sandbox
    ? completion.apply
      ? ['a2g --sandbox happy-path', 'a2g --list-sandbox-scenarios']
      : ['a2g --sandbox apply-happy-path --apply', 'a2g --list-sandbox-scenarios']
    : (completion.nextCommands ?? [])
  return renderOutcomeConfirmation({
    title: 'Migration complete.',
    reference: completion.runId,
    result: sandbox
      ? `Synthetic sandbox scenario ${completion.sandboxScenario} completed through production orchestration; ADO, Entra, and GitHub calls used deterministic fixtures and no provider writes occurred.`
      : completion.apply
        ? 'Approved GitHub changes were applied and the durable workflow completed.'
        : 'The dry-run completed without target writes.',
    record: completion.reportPath,
    nextStep: sandbox
      ? 'Review the report, especially the exact plan, edge cases, approvals, and synthetic boundary transcript.'
      : completion.apply
        ? 'Review the report and resolve any skipped items or edge cases.'
        : 'Review the exact plan and edge cases before deciding whether to run with --apply.',
    nextCommands,
  })
}
