import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'

import type {AdoCredential} from '../../../src/auth/manager.js'
import {AdoService} from '../../../src/services/ado.js'
import {HttpStatusError, NotFoundError, PermissionError} from '../../../src/utils/errors.js'

/**
 * These tests exercise the REAL Azure DevOps adapter against a local `node:http` server bound to
 * 127.0.0.1:0. A loopback server that returns canned JSON is not a live service — it lets the real
 * `azure-devops-node-api`/`typed-rest-client` request-building and response-parsing run end to end,
 * which is where the adapter's mapping and error-translation logic lives.
 */

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
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
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
      }
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

function pat(): AdoCredential {
  return {kind: 'pat', token: 'ado-pat-token', source: 'environment'}
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()))
  servers = []
})

describe('AdoService.getTeams', () => {
  it('maps raw teams, defaults the project name and keeps an optional description', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 200, {
        count: 4,
        value: [
          {
            id: 't1',
            name: 'Team One',
            projectId: 'p1',
            projectName: 'Explicit Project',
            description: 'first',
          },
          {id: 't2', name: 'Team Two', projectId: 'p1'},
          {id: 't3', name: 'Missing Project'},
          {name: 'Missing Id', projectId: 'p1'},
        ],
      }),
    )
    const service = new AdoService(pat(), server.url)

    const teams = await service.getTeams('Fallback Project')

    // Teams missing id/name/projectId are dropped; the survivor without projectName inherits the arg.
    expect(teams).toEqual([
      {
        id: 't1',
        name: 'Team One',
        projectId: 'p1',
        projectName: 'Explicit Project',
        description: 'first',
      },
      {id: 't2', name: 'Team Two', projectId: 'p1', projectName: 'Fallback Project'},
    ])
    expect(server.requests[0]?.url).toContain('/_apis/projects/Fallback%20Project/teams')
    expect(server.requests[0]?.url).toContain('$skip=0')
  })

  it('follows the skip/top pagination loop until a short page ends it', async () => {
    const firstPage = Array.from({length: 100}, (_unused, index) => ({
      id: `team-${index}`,
      name: `Team ${index}`,
      projectId: 'p1',
    }))
    const server = await startServer((request, response) => {
      const skip = new URL(request.url, 'http://local').searchParams.get('$skip')
      sendJson(
        response,
        200,
        skip === '0'
          ? {value: firstPage}
          : {value: [{id: 'team-100', name: 'Team 100', projectId: 'p1'}]},
      )
    })
    const service = new AdoService(pat(), server.url)

    const teams = await service.getTeams('Proj')

    // A full page (>= top of 100) forces a second request; a short second page stops the loop.
    expect(teams).toHaveLength(101)
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]?.url).toContain('$skip=100')
  })

  it('translates a 401 into an HttpStatusError', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 401, {message: 'unauthorized'}),
    )
    const service = new AdoService(pat(), server.url)

    const error = await captureError(service.getTeams('Proj'))

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(401)
  })

  it('translates a 403 into a PermissionError', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 403, {message: 'forbidden'}),
    )
    const service = new AdoService(pat(), server.url)

    const error = await captureError(service.getTeams('Proj'))

    expect(error).toBeInstanceOf(PermissionError)
    expect((error as PermissionError).status).toBe(403)
  })

  it('surfaces a 404 project as a typed NotFoundError', async () => {
    // Regression: `typed-rest-client` RESOLVES a 404 GET with `{result: null}` instead of
    // rejecting, so the adapter's `status === 404` branch was unreachable and the caller
    // dereferenced `null.value`, throwing a TypeError. A TypeError classifies as a permanent
    // ValidationFailure, so a missing project aborted the migration instead of being reported as
    // a missing resource.
    const server = await startServer((_request, response) =>
      sendJson(response, 404, {message: 'not found'}),
    )
    const service = new AdoService(pat(), server.url)

    const error = await captureError(service.getTeams('Missing'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).not.toBeInstanceOf(TypeError)
  })
})

describe('AdoService.getTeamMembers', () => {
  it('maps identity and top-level fields, filling optional email/descriptor and defaulting isContainer', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 200, {
        value: [
          {
            id: 'm1',
            displayName: 'Member One',
            uniqueName: 'm1@example.com',
            email: 'm1@example.com',
            descriptor: 'desc-1',
            isContainer: false,
          },
          {
            identity: {
              id: 'm2',
              displayName: 'Member Two',
              uniqueName: 'm2@example.com',
              mailAddress: 'm2@example.com',
              descriptor: 'desc-2',
              isContainer: true,
            },
          },
          {id: 'm3', displayName: 'Member Three', uniqueName: 'm3@example.com'},
          {id: 'm4', displayName: 'No Unique Name'},
          {displayName: 'No Id', uniqueName: 'ghost@example.com'},
        ],
      }),
    )
    const service = new AdoService(pat(), server.url)

    const members = await service.getTeamMembers('p1', 'team-1')

    expect(members).toEqual([
      {
        id: 'm1',
        displayName: 'Member One',
        uniqueName: 'm1@example.com',
        isContainer: false,
        email: 'm1@example.com',
        descriptor: 'desc-1',
      },
      {
        id: 'm2',
        displayName: 'Member Two',
        uniqueName: 'm2@example.com',
        isContainer: true,
        email: 'm2@example.com',
        descriptor: 'desc-2',
      },
      {id: 'm3', displayName: 'Member Three', uniqueName: 'm3@example.com', isContainer: false},
    ])
    expect(server.requests[0]?.url).toContain('/_apis/projects/p1/teams/team-1/members')
  })
})

describe('AdoService.resolveGroupOriginId', () => {
  it('returns the origin id from a 200 response', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, 200, {originId: 'origin-xyz'}),
    )
    const service = new AdoService(pat(), server.url)

    await expect(service.resolveGroupOriginId('descriptor-1')).resolves.toBe('origin-xyz')
  })

  it('returns null when a 200 response omits the origin id', async () => {
    const server = await startServer((_request, response) => sendJson(response, 200, {}))
    const service = new AdoService(pat(), server.url)

    await expect(service.resolveGroupOriginId('descriptor-1')).resolves.toBeNull()
  })

  it('returns null when the group descriptor cannot be resolved', async () => {
    // This is the method's entire contract, and it never worked: a 404 resolved with
    // `{result: null}`, so the `instanceof NotFoundError` guard never matched and `null.originId`
    // threw a TypeError instead of returning null.
    const server = await startServer((_request, response) =>
      sendJson(response, 404, {message: 'not found'}),
    )
    const service = new AdoService(pat(), server.url)

    await expect(service.resolveGroupOriginId('missing-descriptor')).resolves.toBeNull()
  })
})
