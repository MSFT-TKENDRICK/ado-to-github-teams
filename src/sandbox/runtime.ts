import {isDeepStrictEqual} from 'node:util'
import {Effect, Either, Schema} from 'effect'
import {
  AuthenticationFailure,
  ConflictFailure,
  type DomainFailure,
  NotFoundFailure,
  PermissionFailure,
  TransientFailure,
  ValidationFailure,
  type ServiceName,
} from '../effect/errors.js'
import type {
  ApprovalRecord,
  ApprovalRequest,
  SandboxTranscriptEntry,
} from '../types/index.js'
import type {
  SandboxApproval,
  SandboxError,
  SandboxInteraction,
  SandboxOperation,
  SandboxScenario,
} from './schema.js'

interface InteractionState {
  readonly fixture: SandboxInteraction
  readonly semaphore: Effect.Semaphore
  calls: number
}

interface ApprovalState {
  readonly fixture: SandboxApproval
  calls: number
}

export type SandboxApprovalDecider = (
  request: ApprovalRequest,
  configuredDecision: boolean,
) => Promise<boolean>

function serviceFor(operation: SandboxOperation): ServiceName {
  if (operation.startsWith('ado.')) {
    return 'ado'
  }
  if (operation.startsWith('github.')) {
    return 'github'
  }
  return 'entra'
}

function configuredFailure(operation: SandboxOperation, error: SandboxError): DomainFailure {
  const service = serviceFor(operation)
  const status = error.status === undefined ? {} : {status: error.status}
  switch (error.type) {
    case 'TransientFailure':
      return new TransientFailure({
        service,
        message: error.message,
        ...status,
        ...(error.retryAfterMs === undefined ? {} : {retryAfterMs: error.retryAfterMs}),
      })
    case 'AuthenticationFailure':
      return new AuthenticationFailure({service, message: error.message, ...status})
    case 'PermissionFailure':
      return new PermissionFailure({
        service,
        message: error.message,
        ssoRequired: error.ssoRequired ?? false,
        ...status,
      })
    case 'NotFoundFailure':
      return new NotFoundFailure({service, message: error.message, ...status})
    case 'ConflictFailure':
      return new ConflictFailure({service, message: error.message, ...status})
    case 'ValidationFailure':
      return new ValidationFailure({service, message: error.message, ...status})
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value)
}

export class SandboxRuntime {
  private readonly interactions: InteractionState[]
  private readonly approvals: ApprovalState[]
  private readonly transcriptEntries: SandboxTranscriptEntry[] = []
  private readonly approvalRecords: ApprovalRecord[] = []
  private sequence = 0

  public constructor(public readonly scenario: SandboxScenario) {
    this.interactions = scenario.interactions.map((fixture) => ({
      fixture,
      calls: 0,
      semaphore: Effect.unsafeMakeSemaphore(1),
    }))
    this.approvals = scenario.approvals.map((fixture) => ({fixture, calls: 0}))
  }

  public serialize<A, E, R>(
    operation: SandboxOperation,
    args: unknown,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ValidationFailure, R> {
    const state = this.interactions.find(
      (candidate) =>
        candidate.fixture.operation === operation &&
        isDeepStrictEqual(candidate.fixture.args, args),
    )
    return state
      ? state.semaphore.withPermits(1)(effect)
      : Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message: `No sandbox interaction configured for ${operation} ${stringify(args)}`,
          }),
        )
  }

  public invoke<A, I>(
    operation: SandboxOperation,
    args: unknown,
    valueSchema: Schema.Schema<A, I>,
  ): Effect.Effect<A, DomainFailure> {
    return Effect.gen(this, function* () {
      const state = this.interactions.find(
        (candidate) =>
          candidate.fixture.operation === operation &&
          candidate.calls < candidate.fixture.maxCalls &&
          isDeepStrictEqual(candidate.fixture.args, args),
      )
      if (!state) {
        const exhausted = this.interactions.find(
          (candidate) =>
            candidate.fixture.operation === operation &&
            isDeepStrictEqual(candidate.fixture.args, args),
        )
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message: exhausted
              ? `Sandbox interaction ${exhausted.fixture.id} exceeded maxCalls ${exhausted.fixture.maxCalls}`
              : `No sandbox interaction matched ${operation} ${stringify(args)}`,
          }),
        )
      }

      const responseIndex = Math.min(state.calls, state.fixture.responses.length - 1)
      const response = state.fixture.responses[responseIndex]
      state.calls += 1
      if (
        !response ||
        (state.calls > state.fixture.responses.length && !state.fixture.repeatLast)
      ) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message: `Sandbox interaction ${state.fixture.id} exhausted its responses`,
          }),
        )
      }

      this.sequence += 1
      if ('error' in response) {
        const failure = configuredFailure(operation, response.error)
        this.transcriptEntries.push({
          sequence: this.sequence,
          fixtureId: state.fixture.id,
          operation,
          arguments: stringify(args),
          outcome: `${failure._tag}: ${failure.message}`,
        })
        return yield* Effect.fail(failure)
      }

      const decoded = Schema.decodeUnknownEither(valueSchema, {onExcessProperty: 'error'})(
        response.value,
      )
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message: `Sandbox interaction ${state.fixture.id} produced an invalid ${operation} response`,
          }),
        )
      }
      this.transcriptEntries.push({
        sequence: this.sequence,
        fixtureId: state.fixture.id,
        operation,
        arguments: stringify(args),
        outcome: 'value',
      })
      return decoded.right
    })
  }

  public requestApproval(
    request: ApprovalRequest,
    decide?: SandboxApprovalDecider,
  ): Effect.Effect<boolean, DomainFailure> {
    return Effect.gen(this, function* () {
      const matches = this.approvals.filter(
        (candidate) =>
          candidate.calls < candidate.fixture.maxCalls &&
          request.action.includes(candidate.fixture.actionIncludes),
      )
      if (matches.length !== 1) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message:
              matches.length === 0
                ? `No available sandbox approval matched "${request.action}"`
                : `Multiple sandbox approvals matched "${request.action}": ${matches
                    .map(({fixture}) => fixture.id)
                    .join(', ')}`,
          }),
        )
      }
      const state = matches[0]
      if (!state) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message: `Sandbox approval matching failed for "${request.action}"`,
          }),
        )
      }
      state.calls += 1
      const approved = decide
        ? yield* Effect.tryPromise({
            try: async () => decide(request, state.fixture.decision),
            catch: (error) =>
              new ValidationFailure({
                service: 'sandbox',
                message: `Sandbox approval failed: ${String(error)}`,
              }),
          })
        : state.fixture.decision
      const record: ApprovalRecord = {
        action: request.action,
        context: stringify(request.context),
        approved,
        timestamp: new Date().toISOString(),
      }
      this.approvalRecords.push(record)
      this.sequence += 1
      this.transcriptEntries.push({
        sequence: this.sequence,
        fixtureId: state.fixture.id,
        operation: 'approval.request',
        arguments: stringify({action: request.action, context: request.context}),
        outcome: approved ? 'approved' : 'rejected',
      })
      return approved
    })
  }

  public approvalHistory(): readonly ApprovalRecord[] {
    return [...this.approvalRecords]
  }

  public transcript(): readonly SandboxTranscriptEntry[] {
    return [...this.transcriptEntries]
  }

  public callCount(operation: SandboxOperation): number {
    return this.interactions
      .filter((state) => state.fixture.operation === operation)
      .reduce((total, state) => total + state.calls, 0)
  }

  public verify(): Effect.Effect<void, ValidationFailure> {
    const unmetInteractions = this.interactions
      .filter((state) => state.calls < state.fixture.minCalls)
      .map((state) => `${state.fixture.id} (${state.calls}/${state.fixture.minCalls})`)
    const unmetApprovals = this.approvals
      .filter((state) => state.calls < state.fixture.minCalls)
      .map((state) => `${state.fixture.id} (${state.calls}/${state.fixture.minCalls})`)
    const unmet = [...unmetInteractions, ...unmetApprovals]
    return unmet.length === 0
      ? Effect.void
      : Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message: `Sandbox expectations were not met: ${unmet.join(', ')}`,
          }),
        )
  }
}
