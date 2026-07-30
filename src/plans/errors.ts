import {Data} from 'effect'

export class PlanDecodeFailure extends Data.TaggedError('PlanDecodeFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class PlanValidationFailure extends Data.TaggedError('PlanValidationFailure')<{
  readonly message: string
}> {}

export class PlanCompatibilityFailure extends Data.TaggedError('PlanCompatibilityFailure')<{
  readonly message: string
}> {}

export type PlanFailure = PlanDecodeFailure | PlanValidationFailure | PlanCompatibilityFailure
