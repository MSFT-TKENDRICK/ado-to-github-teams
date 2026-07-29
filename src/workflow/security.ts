import {createHmac, timingSafeEqual} from 'node:crypto'

/**
 * Internal workflow task tokens are deliberately non-expiring: `MigrationWorkflowInput` (which
 * carries the token) is persisted verbatim by the durable workflow SDK and replayed unchanged
 * across step retries and across arbitrarily long human-in-the-loop approval/elicitation waits
 * (see `workflow/migration.ts`'s `createHook` usage). Workflow step code has no access to the
 * HMAC secret (only `worker.ts` does), so it cannot mint a fresh token per call — a hard expiry
 * would therefore either expire tokens out from under a pending human approval, or have to be so
 * long it provides no real protection. This is an accepted internal threat boundary: these tokens
 * authenticate calls from the trusted internal workflow runtime to its own worker process, not an
 * external or user-facing credential.
 *
 * What *is* added, and *is* compatible with retries/resume, is step binding: each token is scoped
 * to exactly one internal task (`prepare`, `apply`, or `escalation`) so a token captured for one
 * internal endpoint cannot be replayed against another.
 */
export type TaskTokenStep = 'prepare' | 'apply' | 'escalation'

function tokenBuffer(token: string): Buffer {
  return Buffer.from(token, 'utf8')
}

export function verifyOpaqueToken(expectedToken: string, suppliedToken: string): boolean {
  const expected = tokenBuffer(expectedToken)
  const supplied = tokenBuffer(suppliedToken)
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

export function createTaskToken(secret: string, runId: string, step: TaskTokenStep): string {
  if (secret.length < 32) {
    throw new Error('WORKFLOW_TASK_SECRET must contain at least 32 characters.')
  }
  return createHmac('sha256', secret).update(`migration-task:${step}:${runId}`).digest('base64url')
}

export function verifyTaskToken(
  secret: string,
  runId: string,
  step: TaskTokenStep,
  suppliedToken: string,
): boolean {
  return verifyOpaqueToken(createTaskToken(secret, runId, step), suppliedToken)
}
