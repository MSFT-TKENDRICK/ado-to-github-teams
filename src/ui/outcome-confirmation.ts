export interface OutcomeConfirmation {
  readonly title: string
  readonly reference: string
  readonly result: string
  readonly record: string
  readonly nextStep: string
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
  ]
}
