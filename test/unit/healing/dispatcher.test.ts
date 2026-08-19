import {describe, expect, it, vi} from 'vitest'

import {ApprovalManager} from '../../../src/checkpoints/approval.js'
import type {ConflictResolver} from '../../../src/healing/conflict-resolver.js'
import {HealingDispatcher} from '../../../src/healing/dispatcher.js'
import type {TokenRefresher} from '../../../src/healing/token-refresher.js'
import {FailureMode} from '../../../src/types/failures.js'

/**
 * Coverage for the self-healing dispatcher.
 *
 * Every branch here decides whether a migration continues, retries, skips an item, or aborts
 * outright, so a misclassification is not cosmetic — it either abandons a run that should have
 * recovered or pushes on through a failure that needed an operator.
 */

const dispatcher = new HealingDispatcher()

interface ErrorFields {
  readonly status?: number
  readonly code?: string
  readonly response?: {status?: number; headers?: Record<string, string | undefined>}
  readonly headers?: Record<string, string | undefined>
  readonly cause?: unknown
}

function errorWith(message: string, fields: ErrorFields = {}): Error {
  return Object.assign(new Error(message), fields)
}

/** A conflict resolver double — only `resolveTeamNameConflict` is reachable from the dispatcher. */
function conflictResolver(approved: boolean): ConflictResolver {
  return {
    resolveTeamNameConflict: vi.fn(async () => ({approved, slug: 'resolved-slug'})),
  } as unknown as ConflictResolver
}

function tokenRefresher(): {refresher: TokenRefresher; calls: string[]} {
  const calls: string[] = []
  const refresher = {
    handleTokenExpiry: vi.fn(async (service: string, retry: () => Promise<unknown>) => {
      calls.push(service)
      await retry()
    }),
  } as unknown as TokenRefresher
  return {refresher, calls}
}

function approvalManager(approved: boolean): ApprovalManager {
  const manager = new ApprovalManager()
  vi.spyOn(manager, 'requestApproval').mockResolvedValue(approved)
  return manager
}

describe('HealingDispatcher.detectFailureMode', () => {
  it.each([
    [
      'a partial failure message',
      'Partial failure while assigning members',
      FailureMode.PARTIAL_FAILURE,
    ],
    ['a circular group message', 'Circular group reference detected', FailureMode.CIRCULAR_GROUP],
    ['a suspended user message', 'The account is suspended', FailureMode.USER_SUSPENDED],
  ])('classifies %s', (_label, message, expected) => {
    expect(dispatcher.detectFailureMode(new Error(message))).toBe(expected)
  })

  it.each([
    [401, FailureMode.TOKEN_EXPIRED],
    [429, FailureMode.RATE_LIMITED],
    [403, FailureMode.PERMISSION_DENIED],
    [404, FailureMode.NOT_FOUND],
    [422, FailureMode.VALIDATION_ERROR],
    [400, FailureMode.VALIDATION_ERROR],
    [409, FailureMode.TEAM_NAME_CONFLICT],
  ])('classifies HTTP %i', (status, expected) => {
    expect(dispatcher.detectFailureMode(errorWith('failed', {status}))).toBe(expected)
  })

  it('reads the status from a nested response when absent at the top level', () => {
    expect(dispatcher.detectFailureMode(errorWith('failed', {response: {status: 404}}))).toBe(
      FailureMode.NOT_FOUND,
    )
  })

  it('distinguishes SSO enforcement from a plain permission denial', () => {
    const viaResponse = errorWith('forbidden', {
      status: 403,
      response: {status: 403, headers: {'x-github-sso': 'required'}},
    })
    const viaHeaders = errorWith('forbidden', {
      status: 403,
      headers: {'x-github-sso': 'required'},
    })
    expect(dispatcher.detectFailureMode(viaResponse)).toBe(FailureMode.SSO_ENFORCEMENT)
    expect(dispatcher.detectFailureMode(viaHeaders)).toBe(FailureMode.SSO_ENFORCEMENT)
    expect(dispatcher.detectFailureMode(errorWith('forbidden', {status: 403}))).toBe(
      FailureMode.PERMISSION_DENIED,
    )
  })

  it('treats an empty SSO header as no SSO enforcement', () => {
    const error = errorWith('forbidden', {status: 403, headers: {'x-github-sso': ''}})
    expect(dispatcher.detectFailureMode(error)).toBe(FailureMode.PERMISSION_DENIED)
  })

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'])(
    'classifies a %s socket error as a network error',
    (code) => {
      expect(dispatcher.detectFailureMode(errorWith('socket failure', {code}))).toBe(
        FailureMode.NETWORK_ERROR,
      )
    },
  )

  it('classifies an undici-wrapped socket failure as a network error', () => {
    // Regression: Node's global `fetch` throws `TypeError: fetch failed` with `code === undefined`
    // and the real SocketError in `cause`. Reading only the top-level code returned UNKNOWN here,
    // and UNKNOWN aborts the migration — so one transient blip during a team-creation loop killed
    // the whole run instead of retrying.
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: errorWith('other side closed', {code: 'UND_ERR_SOCKET'}),
    })
    expect(dispatcher.detectFailureMode(wrapped)).toBe(FailureMode.NETWORK_ERROR)
  })

  it('classifies a dual-stack AggregateError of refused connections as a network error', () => {
    const aggregate = new AggregateError(
      [errorWith('connect ECONNREFUSED ::1:443', {code: 'ECONNREFUSED'})],
      'all attempts failed',
    )
    const wrapped = Object.assign(new TypeError('fetch failed'), {cause: aggregate})
    expect(dispatcher.detectFailureMode(wrapped)).toBe(FailureMode.NETWORK_ERROR)
  })

  it('falls back to UNKNOWN for an unrecognised failure', () => {
    expect(dispatcher.detectFailureMode(new Error('something unexpected'))).toBe(
      FailureMode.UNKNOWN,
    )
  })

  it('prefers a message signal over a status signal', () => {
    // A 404 whose message names a suspended user is a skippable user problem, not a missing
    // resource, so the message must win.
    const error = errorWith('user is suspended', {status: 404})
    expect(dispatcher.detectFailureMode(error)).toBe(FailureMode.USER_SUSPENDED)
  })
})

describe('HealingDispatcher.dispatch token expiry', () => {
  it('refreshes the token and replays the request without asking the caller to retry', async () => {
    const {refresher, calls} = tokenRefresher()
    const retryFn = vi.fn(async () => 'replayed')

    const result = await dispatcher.dispatch({
      error: errorWith('unauthorized', {status: 401}),
      context: {},
      tokenRefresher: refresher,
      tokenService: 'github',
      retryFn,
    })

    expect(calls).toEqual(['github'])
    expect(retryFn).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({healed: true, retryRequest: false})
  })

  it('asks the caller to retry when no refresher is wired', async () => {
    const result = await dispatcher.dispatch({
      error: errorWith('unauthorized', {status: 401}),
      context: {},
    })
    expect(result).toMatchObject({healed: true, retryRequest: true})
    expect(result.action.mode).toBe(FailureMode.TOKEN_EXPIRED)
  })
})

describe('HealingDispatcher.dispatch team name conflicts', () => {
  it('heals when the operator approves the resolved slug', async () => {
    const result = await dispatcher.dispatch({
      error: errorWith('conflict', {status: 409}),
      context: {},
      approval: approvalManager(true),
      conflictResolver: conflictResolver(true),
      conflictInput: {adoName: 'Platform', existingSlug: 'platform'},
    })
    expect(result).toMatchObject({healed: true, userApproved: true})
  })

  it('does not heal when the operator declines', async () => {
    const result = await dispatcher.dispatch({
      error: errorWith('conflict', {status: 409}),
      context: {},
      approval: approvalManager(false),
      conflictResolver: conflictResolver(false),
      conflictInput: {adoName: 'Platform', existingSlug: 'platform'},
    })
    expect(result).toMatchObject({healed: false, userApproved: false})
  })

  it('requires operator approval for the conflict action', async () => {
    const result = await dispatcher.dispatch({
      error: errorWith('conflict', {status: 409}),
      context: {},
    })
    expect(result.action.requiresUserApproval).toBe(true)
    expect(result.action.autoExecute).toBe(false)
  })
})

describe('HealingDispatcher.dispatch SSO enforcement', () => {
  const ssoError = () =>
    errorWith('forbidden', {status: 403, headers: {'x-github-sso': 'required'}})

  it('skips the blocked item when the operator approves', async () => {
    const result = await dispatcher.dispatch({
      error: ssoError(),
      context: {team: 'platform'},
      approval: approvalManager(true),
    })
    expect(result).toMatchObject({
      healed: true,
      userApproved: true,
      skipItem: true,
      abortMigration: false,
    })
  })

  it('aborts the migration when the operator declines', async () => {
    // SSO enforcement is not auto-recoverable: continuing past it without explicit consent would
    // silently skip access the operator may consider mandatory.
    const result = await dispatcher.dispatch({
      error: ssoError(),
      context: {team: 'platform'},
      approval: approvalManager(false),
    })
    expect(result).toMatchObject({
      healed: false,
      userApproved: false,
      skipItem: false,
      abortMigration: true,
    })
  })
})

describe('HealingDispatcher.dispatch outcomes by mode', () => {
  it.each([FailureMode.RATE_LIMITED, FailureMode.NETWORK_ERROR])(
    'requests a retry for %s',
    async (mode) => {
      const result = await dispatcher.dispatch({error: new Error('transient'), mode, context: {}})
      expect(result).toMatchObject({healed: true, retryRequest: true})
      expect(result.action.autoExecute).toBe(true)
    },
  )

  it.each([
    FailureMode.NOT_FOUND,
    FailureMode.VALIDATION_ERROR,
    FailureMode.USER_SUSPENDED,
    FailureMode.CIRCULAR_GROUP,
    FailureMode.PARTIAL_FAILURE,
  ])('skips the item for %s', async (mode) => {
    const result = await dispatcher.dispatch({error: new Error('skippable'), mode, context: {}})
    expect(result).toMatchObject({healed: true, skipItem: true})
  })

  it.each([FailureMode.PERMISSION_DENIED, FailureMode.UNKNOWN])(
    'aborts the migration for %s',
    async (mode) => {
      const result = await dispatcher.dispatch({error: new Error('fatal'), mode, context: {}})
      expect(result).toMatchObject({healed: false, abortMigration: true})
    },
  )

  it('honours an explicitly supplied mode over detection', async () => {
    // The caller sometimes knows more than the error does — `migrate.ts` classifies a name
    // conflict itself before dispatching. An explicit mode must not be second-guessed.
    const result = await dispatcher.dispatch({
      error: errorWith('not found', {status: 404}),
      mode: FailureMode.RATE_LIMITED,
      context: {},
    })
    expect(result.action.mode).toBe(FailureMode.RATE_LIMITED)
    expect(result.retryRequest).toBe(true)
  })

  it('describes every action it returns', async () => {
    const modes = Object.values(FailureMode)
    for (const mode of modes) {
      const result = await dispatcher.dispatch({error: new Error('x'), mode, context: {}})
      expect(result.action.mode).toBe(mode)
      expect(result.action.description.length).toBeGreaterThan(0)
    }
  })
})
