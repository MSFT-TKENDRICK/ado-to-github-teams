import type {AccessToken, GetTokenOptions, TokenCredential} from '@azure/identity'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'

import {ADO_SCOPE, type AdoCredential} from '../../../src/auth/manager.js'
import {
  resolveAdoToken,
  validateAdoCredential,
  validateEntraCredential,
  validateGitHubCredential,
} from '../../../src/auth/validate.js'
import {HttpStatusError} from '../../../src/utils/errors.js'

/**
 * The credential validators use the global `fetch`, so these tests point them at a local
 * `node:http` server on 127.0.0.1:0 to exercise the real request shaping (URL, auth scheme,
 * headers) and the real error translation, and use fake `TokenCredential`s for the Entra paths.
 */

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
}

interface HttpReply {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: unknown
}

interface TestServer {
  readonly url: string
  readonly requests: ReadonlyArray<RecordedRequest>
  readonly close: () => Promise<void>
}

let servers: TestServer[] = []

async function startServer(
  responder: (request: RecordedRequest) => HttpReply,
): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((request, response) => {
    const recorded: RecordedRequest = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
    }
    requests.push(recorded)
    request.resume()
    request.on('end', () => {
      const reply = responder(recorded)
      const headers: Record<string, string> = {...(reply.headers ?? {})}
      if (reply.body === undefined) {
        response.writeHead(reply.status, headers)
        response.end()
        return
      }
      const payload = JSON.stringify(reply.body)
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
      response.writeHead(reply.status, headers)
      response.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  const testServer: TestServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
  servers.push(testServer)
  return testServer
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

interface RecordingCredential {
  readonly credential: TokenCredential
  readonly scopes: ReadonlyArray<string | string[]>
}

function recordingCredential(token: string | null): RecordingCredential {
  const scopes: Array<string | string[]> = []
  const credential: TokenCredential = {
    getToken: (
      requestedScopes: string | string[],
      _options?: GetTokenOptions,
    ): Promise<AccessToken | null> => {
      scopes.push(requestedScopes)
      return Promise.resolve(
        token === null ? null : {token, expiresOnTimestamp: Date.now() + 60_000},
      )
    },
  }
  return {credential, scopes}
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()))
  servers = []
})

describe('resolveAdoToken', () => {
  it('returns the personal access token directly', async () => {
    const credential: AdoCredential = {kind: 'pat', token: 'pat-abc', source: 'environment'}

    await expect(resolveAdoToken(credential)).resolves.toBe('pat-abc')
  })

  it('acquires an Azure DevOps token from an ambient identity using the ADO scope', async () => {
    const recording = recordingCredential('entra-token')
    const credential: AdoCredential = {
      kind: 'entra',
      credential: recording.credential,
      source: 'ambient',
    }

    await expect(resolveAdoToken(credential)).resolves.toBe('entra-token')
    expect(recording.scopes).toEqual([ADO_SCOPE])
  })

  it('throws when the ambient identity yields no token', async () => {
    const recording = recordingCredential(null)
    const credential: AdoCredential = {
      kind: 'entra',
      credential: recording.credential,
      source: 'ambient',
    }

    await expect(resolveAdoToken(credential)).rejects.toThrow(
      /Unable to acquire an Azure DevOps token/,
    )
  })
})

describe('validateAdoCredential', () => {
  it('calls connectionData with Basic auth for a PAT and normalises a trailing slash', async () => {
    const server = await startServer(() => ({status: 200, body: {}}))
    const credential: AdoCredential = {kind: 'pat', token: 'pat-xyz', source: 'environment'}

    await expect(validateAdoCredential(credential, `${server.url}/`)).resolves.toBeUndefined()

    const request = server.requests[0]
    if (!request) {
      throw new Error('Expected the ADO credential validation to issue exactly one request.')
    }
    expect(request.url).toBe(
      '/_apis/connectionData?connectOptions=none&lastChangeId=-1&lastChangeId64=-1',
    )
    const expected = `Basic ${Buffer.from(':pat-xyz').toString('base64')}`
    expect(request.headers.authorization).toBe(expected)
  })

  it('uses Bearer auth when validating an ambient Entra credential', async () => {
    const server = await startServer(() => ({status: 200, body: {}}))
    const recording = recordingCredential('entra-token')
    const credential: AdoCredential = {
      kind: 'entra',
      credential: recording.credential,
      source: 'ambient',
    }

    await expect(validateAdoCredential(credential, server.url)).resolves.toBeUndefined()
    expect(server.requests[0]?.headers.authorization).toBe('Bearer entra-token')
  })

  it('translates a non-2xx response into an HttpStatusError with propagated headers', async () => {
    const server = await startServer(() => ({
      status: 401,
      headers: {'retry-after': '30', 'x-github-sso': 'required; url=https://example/sso'},
      body: {message: 'nope'},
    }))
    const credential: AdoCredential = {kind: 'pat', token: 'pat-xyz', source: 'environment'}

    const error = await captureError(validateAdoCredential(credential, server.url))

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(401)
    expect((error as HttpStatusError).headers['retry-after']).toBe('30')
    expect((error as HttpStatusError).headers['x-github-sso']).toContain('required')
  })
})

describe('validateGitHubCredential', () => {
  it('requests the authenticated user with the expected headers', async () => {
    const server = await startServer(() => ({status: 200, body: {login: 'ada'}}))

    await expect(validateGitHubCredential('gh-token', `${server.url}/`)).resolves.toBeUndefined()

    const request = server.requests[0]
    if (!request) {
      throw new Error('Expected the GitHub credential validation to issue exactly one request.')
    }
    expect(request.url).toBe('/user')
    expect(request.headers.authorization).toBe('Bearer gh-token')
    expect(request.headers.accept).toBe('application/vnd.github+json')
    expect(request.headers['user-agent']).toBe('ado-to-github-teams')
  })

  it('translates a non-2xx response into an HttpStatusError with the SSO header', async () => {
    const server = await startServer(() => ({
      status: 403,
      headers: {'x-github-sso': 'required; url=https://example/sso'},
      body: {message: 'forbidden'},
    }))

    const error = await captureError(validateGitHubCredential('gh-token', server.url))

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(403)
    expect((error as HttpStatusError).headers['x-github-sso']).toContain('required')
  })
})

describe('validateEntraCredential', () => {
  it('resolves when the credential returns a token for the requested scopes', async () => {
    const recording = recordingCredential('graph-token')

    await expect(
      validateEntraCredential(recording.credential, ['scope/a', 'scope/b']),
    ).resolves.toBeUndefined()
    expect(recording.scopes).toEqual([['scope/a', 'scope/b']])
  })

  it('throws when the credential yields no token', async () => {
    const recording = recordingCredential(null)

    await expect(validateEntraCredential(recording.credential, ['scope/a'])).rejects.toThrow(
      /Unable to acquire token for Entra validation/,
    )
  })
})
