import {randomUUID} from 'node:crypto'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {createTaskToken} from '../../src/workflow/security.js'
import {bootWorkerApp, type WorkerAppHandle} from '../contract/support/worker-app.js'

/**
 * HTTP surface coverage for the real `src/worker.ts` Express application.
 *
 * `bootWorkerApp` boots the actual application module in-process — real routing, real auth
 * middleware, real schema decode, and a real temp-file-backed `CheckpointManager` — with only the
 * two boundaries this repository does not own replaced (the `workflow/api` orchestration SDK and
 * the NATS/Turso-backed World).
 *
 * Until now that harness was reachable only from `test/contract`, which is skipped entirely on
 * platforms without a Pact FFI prebuild (win32/arm64). `src/worker.ts` therefore reported 0%
 * coverage on those machines even though it is exercised on CI. Driving the same harness from a
 * platform-independent suite makes the worker's authorization, validation, and not-found paths
 * verifiable everywhere.
 */

let worker: WorkerAppHandle

beforeAll(async () => {
  worker = await bootWorkerApp()
}, 60_000)

afterAll(async () => {
  await worker.close()
})

/** A syntactically valid migration run id — the worker enforces a strict UUID pattern. */
function newRunId(): string {
  return randomUUID()
}

function authorized(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  }
}

describe('worker health endpoint', () => {
  it('reports the configured world once startup completes', async () => {
    const response = await fetch(`${worker.baseUrl}/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {status: string; world: string}
    expect(body.status).toBe('ok')
    expect(body.world).toBe('local')
  })

  it('does not require an API token', async () => {
    // `/health` is registered before the auth middleware on purpose: a probe must not need a
    // credential. Pinning this stops a future reordering from breaking liveness checks.
    const response = await fetch(`${worker.baseUrl}/health`)
    expect(response.status).toBe(200)
  })
})

describe('worker API authorization', () => {
  const protectedRoutes = [
    {method: 'GET', path: '/api/migrations'},
    {method: 'GET', path: '/api/migrations/latest'},
    {method: 'GET', path: `/api/migrations/${'a'.repeat(8)}`},
    {method: 'POST', path: '/api/migrations'},
  ] as const

  it.each(protectedRoutes)('rejects $method $path without a bearer token', async (route) => {
    const response = await fetch(`${worker.baseUrl}${route.path}`, {
      method: route.method,
      headers: {'content-type': 'application/json'},
      ...(route.method === 'POST' ? {body: '{}'} : {}),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: 'Unauthorized'})
  })

  it('rejects a bearer token that is not the configured API token', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations`,
      authorized('not-the-configured-api-token-value-000000'),
    )
    expect(response.status).toBe(401)
  })

  it('rejects an Authorization header that is not a Bearer scheme', async () => {
    const response = await fetch(`${worker.baseUrl}/api/migrations`, {
      headers: {authorization: `Basic ${worker.apiToken}`},
    })
    expect(response.status).toBe(401)
  })
})

describe('worker migration listing', () => {
  it('lists sessions for an empty store', async () => {
    const response = await fetch(`${worker.baseUrl}/api/migrations`, authorized(worker.apiToken))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('accepts the blocking-only filter', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations?blocking=true`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it.each(['0', '-5', 'abc'])('rejects a non-positive-integer limit of %s', async (limit) => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations?limit=${limit}`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({error: 'limit must be a positive integer'})
  })

  it.each(['1.5', '5abc'])(
    'truncates a leading-numeric limit of %s rather than rejecting',
    async (limit) => {
      // Documented tolerance, not an oversight: the handler uses `Number.parseInt`, which stops at
      // the first non-numeric character. `1.5` becomes 1 and `5abc` becomes 5, both safe positive
      // integers. Pinned so a future switch to `Number(...)` — which would yield NaN for `5abc` and
      // start rejecting requests that work today — is a visible, deliberate contract change.
      const response = await fetch(
        `${worker.baseUrl}/api/migrations?limit=${limit}`,
        authorized(worker.apiToken),
      )
      expect(response.status).toBe(200)
    },
  )

  it('accepts an explicit positive limit', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations?limit=5`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(200)
  })

  it('returns null when no migration has ever run', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations/latest`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
  })
})

describe('worker migration creation validation', () => {
  it.each([
    ['a missing runId', {}],
    ['a non-string runId', {runId: 42}],
    ['a runId that is not a UUID', {runId: 'not-a-uuid'}],
    // A v4-shaped string with an out-of-range version nibble must still be refused: the worker
    // pins the pattern so an arbitrary caller-supplied string can never become a storage key.
    ['a UUID with an invalid version nibble', {runId: '00000000-0000-0000-0000-000000000000'}],
  ])('rejects %s', async (_label, body) => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations`,
      authorized(worker.apiToken, {method: 'POST', body: JSON.stringify(body)}),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({error: 'A valid migration run ID is required'})
  })

  it('surfaces a malformed JSON body through the error handler', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations`,
      authorized(worker.apiToken, {method: 'POST', body: '{"runId":'}),
    )
    // The terminal error handler maps every unhandled error to 500. Recorded as observed
    // behaviour: a malformed body is arguably a 400, but changing it would alter the published
    // contract, so this test pins what the worker actually does today.
    expect(response.status).toBe(500)
    const body = (await response.json()) as {error: string}
    expect(typeof body.error).toBe('string')
  })
})

describe('worker migration lookup', () => {
  it('returns 404 for an unknown migration', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations/${newRunId()}`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: 'Migration not found'})
  })

  it('returns 404 for a plan artifact with no checkpoint', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations/${newRunId()}/plan-artifact`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: 'Migration not found'})
  })

  it('returns 404 for a report with no checkpoint', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations/${newRunId()}/report`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: 'Migration not found'})
  })

  it('returns 404 for an escalation report with no checkpoint', async () => {
    const response = await fetch(
      `${worker.baseUrl}/api/migrations/${newRunId()}/escalation-report`,
      authorized(worker.apiToken),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: 'Migration not found'})
  })
})

describe('worker internal task authorization', () => {
  const steps = ['prepare', 'apply', 'escalation'] as const

  it.each(steps)('rejects a %s task without a task token', async (step) => {
    const response = await fetch(`${worker.baseUrl}/internal/migrations/${newRunId()}/${step}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: 'Unauthorized workflow task'})
  })

  it.each(steps)('rejects a %s task presenting the API token instead', async (step) => {
    // The API token and the task token are different credentials with different scopes. An
    // operator credential must never be sufficient to drive an internal workflow step.
    const response = await fetch(
      `${worker.baseUrl}/internal/migrations/${newRunId()}/${step}`,
      authorized(worker.apiToken, {method: 'POST', body: '{}'}),
    )
    expect(response.status).toBe(401)
  })

  it('rejects a task token minted for a different run', async () => {
    const tokenRunId = newRunId()
    const requestRunId = newRunId()
    const token = createTaskToken(worker.taskSecret, tokenRunId, 'prepare')
    const response = await fetch(
      `${worker.baseUrl}/internal/migrations/${requestRunId}/prepare`,
      authorized(token, {method: 'POST', body: '{}'}),
    )
    expect(response.status).toBe(401)
  })

  it('rejects a task token minted for a different step', async () => {
    const runId = newRunId()
    const token = createTaskToken(worker.taskSecret, runId, 'prepare')
    const response = await fetch(
      `${worker.baseUrl}/internal/migrations/${runId}/apply`,
      authorized(token, {method: 'POST', body: '{}'}),
    )
    expect(response.status).toBe(401)
  })
})
