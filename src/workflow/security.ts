import {createHmac, timingSafeEqual} from 'node:crypto'

function tokenBuffer(token: string): Buffer {
  return Buffer.from(token, 'utf8')
}

export function verifyOpaqueToken(expectedToken: string, suppliedToken: string): boolean {
  const expected = tokenBuffer(expectedToken)
  const supplied = tokenBuffer(suppliedToken)
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

export function createTaskToken(secret: string, runId: string): string {
  if (secret.length < 32) {
    throw new Error('WORKFLOW_TASK_SECRET must contain at least 32 characters.')
  }
  return createHmac('sha256', secret)
    .update(`migration-task:${runId}`)
    .digest('base64url')
}

export function verifyTaskToken(
  secret: string,
  runId: string,
  suppliedToken: string,
): boolean {
  return verifyOpaqueToken(createTaskToken(secret, runId), suppliedToken)
}
