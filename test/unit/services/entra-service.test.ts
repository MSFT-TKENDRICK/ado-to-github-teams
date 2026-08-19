import http from 'node:http'
import type {AddressInfo} from 'node:net'
import type {TokenCredential} from '@azure/identity'
import {Client} from '@microsoft/microsoft-graph-client'
import {afterEach, describe, expect, it} from 'vitest'

import {EntraService} from '../../../src/services/entra.js'
import {HttpStatusError, NotFoundError, PermissionError} from '../../../src/utils/errors.js'

/**
 * These tests run the REAL Microsoft Graph adapter against a local `node:http` server. A real
 * `@microsoft/microsoft-graph-client` `Client` is constructed with a stub auth provider and a
 * loopback `baseUrl`, so the production request-building, pagination, transitive-group recursion
 * and error translation all execute against canned JSON instead of a live tenant.
 */

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

interface TestServer {
  readonly url: string
  readonly requests: ReadonlyArray<RecordedRequest>
  readonly close: () => Promise<void>
}

type Responder = (request: RecordedRequest, response: http.ServerResponse) => void

let servers: TestServer[] = []

async function startServer(responder: Responder): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const recorded: RecordedRequest = {method: request.method ?? '', url: request.url ?? ''}
      requests.push(recorded)
      responder(recorded, response)
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

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
  })
  response.end(payload)
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

const stubCredential: TokenCredential = {
  getToken: async () => ({token: 'unused', expiresOnTimestamp: Date.now() + 60_000}),
}

function makeGraphClient(baseUrl: string): Client {
  return Client.initWithMiddleware({
    authProvider: {getAccessToken: async () => 'graph-test-token'},
    baseUrl,
    defaultVersion: 'v1.0',
  })
}

function makeService(baseUrl: string): EntraService {
  return new EntraService(
    stubCredential,
    ['https://graph.microsoft.com/.default'],
    makeGraphClient(baseUrl),
    `${baseUrl}/v1.0`,
  )
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()))
  servers = []
})

describe('EntraService.getGroupMembers (direct)', () => {
  it('maps members, detects guests, keeps optional fields and drops incomplete objects', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 200, {
        value: [
          {
            id: 'u1',
            displayName: 'User One',
            userPrincipalName: 'u1@x.com',
            mail: 'u1@x.com',
            accountEnabled: true,
            userType: 'Member',
          },
          {id: 'u2', displayName: 'Guest User', userPrincipalName: 'u2@x.com', userType: 'Guest'},
          {id: 'u3', displayName: 'No Upn'},
          {displayName: 'No Id', userPrincipalName: 'u4@x.com'},
        ],
      }),
    )

    const members = await makeService(server.url).getGroupMembers('group-1')

    expect(members).toEqual([
      {
        id: 'u1',
        displayName: 'User One',
        userPrincipalName: 'u1@x.com',
        isGuest: false,
        mail: 'u1@x.com',
        accountEnabled: true,
      },
      {id: 'u2', displayName: 'Guest User', userPrincipalName: 'u2@x.com', isGuest: true},
    ])
    expect(server.requests[0]?.url).toContain('/groups/group-1/members')
  })

  it('follows @odata.nextLink pagination and normalises a production-host next link', async () => {
    const server = await startServer((request, response) => {
      if (request.url.includes('cursor=page2')) {
        sendJson(response, 200, {
          value: [{id: 'u2', displayName: 'Two', userPrincipalName: 'two@x.com'}],
        })
        return
      }
      sendJson(response, 200, {
        value: [{id: 'u1', displayName: 'One', userPrincipalName: 'one@x.com'}],
        // A production-host next link exercises normalizeNextLink's slice branch; after slicing it
        // resolves back to this loopback server.
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/group-1/members?cursor=page2',
      })
    })

    const members = await makeService(server.url).getGroupMembers('group-1')

    expect(members.map((member) => member.id)).toEqual(['u1', 'u2'])
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]?.url).toContain('cursor=page2')
  })

  it('translates a 401 into an HttpStatusError', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 401, {error: {code: 'unauth', message: 'no'}}),
    )

    const error = await captureError(makeService(server.url).getGroupMembers('group-1'))

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(401)
  })

  it('translates a 403 into a PermissionError', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 403, {error: {code: 'forbidden', message: 'no'}}),
    )

    const error = await captureError(makeService(server.url).getGroupMembers('group-1'))

    expect(error).toBeInstanceOf(PermissionError)
    expect((error as PermissionError).status).toBe(403)
  })
})

describe('EntraService.getGroupMembers (transitive)', () => {
  it('flattens nested groups and de-duplicates members that appear at multiple levels', async () => {
    const server = await startServer((request, response) => {
      if (request.url.includes('/groups/child/')) {
        sendJson(response, 200, {
          value: [
            {
              id: 'leaf',
              displayName: 'Leaf',
              userPrincipalName: 'leaf@x.com',
              '@odata.type': '#microsoft.graph.user',
            },
            {
              id: 'direct',
              displayName: 'Direct',
              userPrincipalName: 'direct@x.com',
              '@odata.type': '#microsoft.graph.user',
            },
          ],
        })
        return
      }
      sendJson(response, 200, {
        value: [
          {
            id: 'direct',
            displayName: 'Direct',
            userPrincipalName: 'direct@x.com',
            '@odata.type': '#microsoft.graph.user',
          },
          {id: 'child', displayName: 'Child Group', '@odata.type': '#microsoft.graph.group'},
        ],
      })
    })

    const members = await makeService(server.url).getGroupMembers('parent', true)

    expect(members).toEqual([
      {id: 'direct', displayName: 'Direct', userPrincipalName: 'direct@x.com', isGuest: false},
      {id: 'leaf', displayName: 'Leaf', userPrincipalName: 'leaf@x.com', isGuest: false},
    ])
  })

  it('throws CIRCULAR_GROUP when a group contains itself', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 200, {
        value: [{id: 'cyclic', displayName: 'Cyclic', '@odata.type': '#microsoft.graph.group'}],
      }),
    )

    const error = await captureError(makeService(server.url).getGroupMembers('cyclic', true))

    expect((error as Error).name).toBe('CIRCULAR_GROUP')
  })

  it('throws NESTED_GROUP_DEPTH_EXCEEDED past six levels of nesting', async () => {
    const server = await startServer((request, response) => {
      const match = /\/groups\/g(\d+)\//.exec(request.url)
      const level = match ? Number.parseInt(match[1] ?? '0', 10) : 0
      sendJson(response, 200, {
        value: [
          {
            id: `g${level + 1}`,
            displayName: `Group ${level + 1}`,
            '@odata.type': '#microsoft.graph.group',
          },
        ],
      })
    })

    const error = await captureError(makeService(server.url).getGroupMembers('g0', true))

    expect((error as Error).name).toBe('NESTED_GROUP_DEPTH_EXCEEDED')
  })
})

describe('EntraService.resolveUserByUpn', () => {
  it('resolves and maps a user, preserving a disabled account flag', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 200, {
        id: 'u9',
        displayName: 'Nine',
        userPrincipalName: 'nine@x.com',
        mail: 'nine@x.com',
        accountEnabled: false,
        userType: 'Member',
      }),
    )

    await expect(makeService(server.url).resolveUserByUpn('nine@x.com')).resolves.toEqual({
      id: 'u9',
      displayName: 'Nine',
      userPrincipalName: 'nine@x.com',
      isGuest: false,
      mail: 'nine@x.com',
      accountEnabled: false,
    })
  })

  it('returns null when a 200 response is missing required identity fields', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 200, {displayName: 'No Id', userPrincipalName: 'x@x.com'}),
    )

    await expect(makeService(server.url).resolveUserByUpn('x@x.com')).resolves.toBeNull()
  })

  it('returns null on a 404', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 404, {error: {code: 'Request_ResourceNotFound', message: 'not found'}}),
    )

    await expect(makeService(server.url).resolveUserByUpn('missing@x.com')).resolves.toBeNull()
  })

  it('rethrows a non-404 failure as a typed domain error', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 403, {error: {code: 'forbidden', message: 'no'}}),
    )

    const error = await captureError(makeService(server.url).resolveUserByUpn('denied@x.com'))

    expect(error).toBeInstanceOf(PermissionError)
    expect(error).not.toBeInstanceOf(NotFoundError)
  })
})

describe('EntraService construction', () => {
  it('builds its own middleware Graph client when none is injected', () => {
    // Covers createGraphClient; no request is issued so no live tenant is contacted.
    const service = new EntraService(stubCredential, ['https://graph.microsoft.com/.default'])

    expect(service).toBeInstanceOf(EntraService)
  })
})
