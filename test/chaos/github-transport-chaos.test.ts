import type {TokenCredential} from '@azure/identity'
import {Cause, Effect, Exit, Option} from 'effect'
import {afterEach, describe, expect, it} from 'vitest'

import type {ResolvedCredentials} from '../../src/auth/manager.js'
import {classifyServiceError} from '../../src/effect/classify.js'
import {makeGitHubLayer} from '../../src/effect/layers.js'
import {GitHubServiceTag, type GitHubServiceFx} from '../../src/effect/services.js'
import {startFaultServer, type FaultServer, type TransportFault} from './support/fault-server.js'

/**
 * Transport-level chaos against the REAL GitHub adapter.
 *
 * These tests exist because of a specific gap. `test/unit` proves the orchestrator reacts correctly
 * to a `TransientFailure` *value*, and `test/contract` proves the adapter's request/response shapes
 * match the modelled contract. Neither proves the step in between: that the HTTP client actually
 * produces a retryable failure when a real peer resets a socket, hangs, or truncates a body. A
 * fault-injection Layer cannot prove it either — it replaces the boundary where the fault lives.
 *
 * The invariant under test matters operationally. `classifyServiceError` falls through to
 * `ValidationFailure` for anything it does not recognise, and `ValidationFailure` is NOT retryable.
 * If a transient network fault is misclassified as a validation error, a long-running team
 * migration aborts permanently on a blip that should simply have been retried.
 */

const ambientCredential: TokenCredential = {
  getToken: async () => ({token: 'unused', expiresOnTimestamp: Date.now() + 60_000}),
}

const credentials: ResolvedCredentials = {
  ado: {kind: 'entra', credential: ambientCredential, source: 'ambient'},
  githubToken: 'chaos-token',
  githubSource: 'environment',
  entraCredential: ambientCredential,
  entraScopes: ['https://graph.microsoft.com/.default'],
}

let server: FaultServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function withFaults(script: ReadonlyArray<TransportFault>): Promise<FaultServer> {
  server = await startFaultServer(script)
  return server
}

/** Runs a GitHub adapter call against `baseUrl`, surfacing the real typed domain failure. */
function runGitHub<A>(
  baseUrl: string,
  use: (service: GitHubServiceFx) => Effect.Effect<A, unknown>,
): Promise<Exit.Exit<A, unknown>> {
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* GitHubServiceTag
      return yield* use(service)
    }).pipe(Effect.provide(makeGitHubLayer(credentials, 'contoso', baseUrl))),
  )
}

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) {
    throw new Error('expected a failure')
  }
  const failure = Cause.failureOption(exit.cause)
  return Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)
}

/** Captures the raw client error for a request, before any domain classification. */
async function rawClientError(baseUrl: string): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/orgs/contoso/teams/core`)
    await response.text()
    return undefined
  } catch (error: unknown) {
    return error
  }
}

describe('GitHub adapter transport chaos', () => {
  it('surfaces a real socket reset as a retryable transient failure', async () => {
    const faults = await withFaults([{kind: 'reset-before-headers'}])

    const raw = await rawClientError(faults.url)
    expect(raw).toBeInstanceOf(Error)

    const classified = classifyServiceError('github', raw)
    expect(classified._tag).toBe('TransientFailure')
  })

  it('surfaces a reset part-way through a response body as retryable', async () => {
    const faults = await withFaults([
      {kind: 'reset-mid-body', status: 200, partialBody: '{"id":1,"slug":"co'},
    ])

    const raw = await rawClientError(faults.url)
    expect(raw).toBeInstanceOf(Error)
    expect(classifyServiceError('github', raw)._tag).toBe('TransientFailure')
  })

  it('surfaces a truncated body as retryable rather than as a permanent validation error', async () => {
    const faults = await withFaults([
      {kind: 'truncated-body', status: 200, partialBody: '{"id":1,"slug":"core"}'},
    ])

    const raw = await rawClientError(faults.url)
    expect(raw).toBeInstanceOf(Error)
    expect(classifyServiceError('github', raw)._tag).toBe('TransientFailure')
  })

  it('refuses a connection to a closed port as retryable', async () => {
    // ECONNREFUSED is the one transport fault reachable without a live peer: start a server,
    // learn its port, then shut it down so the port is genuinely closed.
    const closed = await startFaultServer([{kind: 'ok', status: 200, body: {}}])
    const {url} = closed
    await closed.close()

    const raw = await rawClientError(url)
    expect(raw).toBeInstanceOf(Error)
    expect(classifyServiceError('github', raw)._tag).toBe('TransientFailure')
  })

  it('classifies a throttling response and preserves its Retry-After budget', async () => {
    const faults = await withFaults([{kind: 'throttled', status: 429, retryAfterSeconds: 7}])

    const exit = await runGitHub(faults.url, (service) => service.getTeamBySlug('core'))
    const failure = failureOf(exit) as {
      readonly _tag?: string
      readonly retryAfterMs?: number
      readonly status?: number
    }

    expect(failure._tag).toBe('TransientFailure')
    expect(failure.status).toBe(429)
    // The Retry-After header must survive into the domain failure, otherwise the retry policy
    // backs off on its own schedule and keeps hammering a throttled provider.
    expect(failure.retryAfterMs).toBe(7000)
  })

  it('keeps the retry budget finite when the peer resets every attempt', async () => {
    const faults = await withFaults([{kind: 'reset-before-headers'}])

    const exit = await runGitHub(faults.url, (service) => service.getTeamBySlug('core'))

    expect(Exit.isFailure(exit)).toBe(true)
    // AGENTS.md: "Retries have finite budgets." An unbounded retry against a hard-down peer is a
    // hang, not resilience. The exact ceiling is a policy decision; that one exists is an invariant.
    expect(faults.requestCount()).toBeGreaterThanOrEqual(1)
    expect(faults.requestCount()).toBeLessThanOrEqual(10)
  })

  it('recovers when a transient reset is followed by a healthy response', async () => {
    const faults = await withFaults([
      {kind: 'reset-before-headers'},
      {
        kind: 'ok',
        status: 200,
        body: {id: 42, name: 'Core', slug: 'core', description: '', privacy: 'closed'},
      },
    ])

    const exit = await runGitHub(faults.url, (service) => service.getTeamBySlug('core'))

    // Either the adapter retried and succeeded, or it surfaced a retryable failure for the caller
    // to retry. What it must never do is surface a non-retryable failure for a transient fault.
    if (Exit.isFailure(exit)) {
      const failure = failureOf(exit) as {readonly _tag?: string}
      expect(failure._tag).toBe('TransientFailure')
    } else {
      expect(faults.requestCount()).toBeGreaterThan(1)
    }
  })
})
