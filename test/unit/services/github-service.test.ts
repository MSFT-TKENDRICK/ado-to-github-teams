import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'

import {GitHubService} from '../../../src/services/github.js'
import {
  AmbiguousMatchError,
  HttpStatusError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from '../../../src/utils/errors.js'

/**
 * These tests run the REAL GitHub adapter (Octokit REST, GraphQL and pagination) against a local
 * `node:http` server bound to 127.0.0.1:0 and pointed at through Octokit's `baseUrl`. This mirrors
 * the established pattern in `test/contract` and `test/chaos`: a loopback server is not a live
 * service, and it lets the production request-shaping and response/error mapping run for real.
 *
 * Only non-retryable statuses (401/403/404/409/422) are used for error paths so `withRetry` does
 * not back off; retryable statuses are covered by the chaos suite.
 */

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

interface Route {
  readonly method: string
  readonly match: (url: string) => boolean
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

async function startRoutes(routes: ReadonlyArray<Route>): Promise<TestServer> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
    })
    request.on('end', () => {
      const url = request.url ?? ''
      requests.push({method: request.method ?? '', url, body: raw})
      const route = routes.find(
        (candidate) => candidate.method === request.method && candidate.match(url),
      )
      if (!route) {
        const payload = JSON.stringify({message: `unrouted ${request.method} ${url}`})
        response.writeHead(500, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        })
        response.end(payload)
        return
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(route.headers ?? {}),
      }
      if (route.body === undefined) {
        response.writeHead(route.status, headers)
        response.end()
        return
      }
      const payload = JSON.stringify(route.body)
      headers['content-length'] = String(Buffer.byteLength(payload))
      response.writeHead(route.status, headers)
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

function parseJson(body: string | undefined): unknown {
  return JSON.parse(body ?? '{}') as unknown
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

function makeService(baseUrl: string): GitHubService {
  return new GitHubService('gh-token', 'acme', baseUrl)
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()))
  servers = []
})

describe('GitHubService.getTeamBySlug', () => {
  it('maps a team including its parent', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 200,
        body: {
          id: 1,
          slug: 'core',
          name: 'Core',
          description: 'Core eng',
          privacy: 'closed',
          parent: {id: 7, slug: 'eng'},
        },
      },
    ])

    await expect(makeService(server.url).getTeamBySlug('core')).resolves.toEqual({
      id: 1,
      slug: 'core',
      name: 'Core',
      privacy: 'closed',
      description: 'Core eng',
      parentTeam: {id: 7, slug: 'eng'},
    })
  })

  it('rejects a team missing a valid privacy setting', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 200,
        body: {id: 1, slug: 'core', name: 'Core'},
      },
    ])

    await expect(makeService(server.url).getTeamBySlug('core')).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('returns null on a 404', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 404,
        body: {message: 'Not Found'},
      },
    ])

    await expect(makeService(server.url).getTeamBySlug('core')).resolves.toBeNull()
  })

  it('preserves the SSO challenge header on a 403', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 403,
        headers: {'x-github-sso': 'required; url=https://github.com/orgs/acme/sso'},
        body: {message: 'SSO required'},
      },
    ])

    const error = await captureError(makeService(server.url).getTeamBySlug('core'))

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(403)
    expect((error as HttpStatusError).headers['x-github-sso']).toContain('required')
  })

  it('maps a plain 403 without SSO to a PermissionError', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 403,
        body: {message: 'Forbidden'},
      },
    ])

    const error = await captureError(makeService(server.url).getTeamBySlug('core'))

    expect(error).toBeInstanceOf(PermissionError)
    expect((error as PermissionError).status).toBe(403)
  })

  it('maps a 401 to an HttpStatusError', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 401,
        body: {message: 'Bad creds'},
      },
    ])

    const error = await captureError(makeService(server.url).getTeamBySlug('core'))

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(401)
  })
})

describe('GitHubService.createTeam', () => {
  it('is idempotent when a compatible team already exists (no create call)', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 200,
        body: {id: 5, slug: 'core', name: 'Core', privacy: 'closed'},
      },
    ])

    await expect(
      makeService(server.url).createTeam({slug: 'core', name: 'Core', privacy: 'closed'}),
    ).resolves.toEqual({id: 5, slug: 'core', name: 'Core', privacy: 'closed'})
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
  })

  it('rejects when an existing team has a different name', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 200,
        body: {id: 5, slug: 'core', name: 'Different', privacy: 'closed'},
      },
    ])

    const error = await captureError(
      makeService(server.url).createTeam({slug: 'core', name: 'Core', privacy: 'closed'}),
    )

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(409)
  })

  it('rejects when an existing team has incompatible privacy', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 200,
        body: {id: 5, slug: 'core', name: 'Core', privacy: 'secret'},
      },
    ])

    const error = await captureError(
      makeService(server.url).createTeam({slug: 'core', name: 'Core', privacy: 'closed'}),
    )

    expect(error).toBeInstanceOf(HttpStatusError)
    expect((error as HttpStatusError).status).toBe(409)
  })

  it('creates a nested team after the idempotency lookup returns 404', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/platform',
        status: 404,
        body: {message: 'Not Found'},
      },
      {
        method: 'POST',
        match: (u) => u === '/orgs/acme/teams',
        status: 201,
        body: {
          id: 8,
          slug: 'platform',
          name: 'Platform',
          description: null,
          privacy: 'closed',
          parent: {id: 7, slug: 'eng'},
        },
      },
    ])

    const team = await makeService(server.url).createTeam({
      slug: 'platform',
      name: 'Platform',
      privacy: 'closed',
      parentTeamId: 7,
    })

    expect(team).toEqual({
      id: 8,
      slug: 'platform',
      name: 'Platform',
      privacy: 'closed',
      parentTeam: {id: 7, slug: 'eng'},
    })
    const post = server.requests.find((request) => request.method === 'POST')
    expect(parseJson(post?.body)).toMatchObject({
      name: 'Platform',
      description: '',
      privacy: 'closed',
      parent_team_id: 7,
    })
  })

  it('maps a 422 create failure to a ValidationError', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core',
        status: 404,
        body: {message: 'Not Found'},
      },
      {
        method: 'POST',
        match: (u) => u === '/orgs/acme/teams',
        status: 422,
        body: {message: 'Validation Failed'},
      },
    ])

    const error = await captureError(
      makeService(server.url).createTeam({slug: 'core', name: 'Core', privacy: 'closed'}),
    )

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).status).toBe(422)
  })
})

describe('GitHubService.addTeamMember', () => {
  it('returns early when the user is already an active member', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 200,
        body: {state: 'active', role: 'member'},
      },
    ])

    await expect(makeService(server.url).addTeamMember('core', 'ada')).resolves.toBeUndefined()
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
  })

  it('adds the member when no membership exists yet', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 404,
        body: {message: 'Not Found'},
      },
      {
        method: 'PUT',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 200,
        body: {state: 'pending', role: 'member'},
      },
    ])

    await expect(makeService(server.url).addTeamMember('core', 'ada')).resolves.toBeUndefined()
    const put = server.requests.find((request) => request.method === 'PUT')
    expect(parseJson(put?.body)).toEqual({role: 'member'})
  })

  it('maps a non-404 membership lookup failure', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 403,
        body: {message: 'Forbidden'},
      },
    ])

    const error = await captureError(makeService(server.url).addTeamMember('core', 'ada'))

    expect(error).toBeInstanceOf(PermissionError)
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(0)
  })

  it('maps a 422 on assignment to a ValidationError', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 404,
        body: {message: 'Not Found'},
      },
      {
        method: 'PUT',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 422,
        body: {message: 'suspended'},
      },
    ])

    const error = await captureError(makeService(server.url).addTeamMember('core', 'ada'))

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).status).toBe(422)
  })

  it('maps a 404 on assignment to a NotFoundError', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 404,
        body: {message: 'Not Found'},
      },
      {
        method: 'PUT',
        match: (u) => u === '/orgs/acme/teams/core/memberships/ada',
        status: 404,
        body: {message: 'Not Found'},
      },
    ])

    const error = await captureError(makeService(server.url).addTeamMember('core', 'ada'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as NotFoundError).status).toBe(404)
  })
})

describe('GitHubService.findUserByEmail', () => {
  it('returns null when the search matches nobody', async () => {
    const server = await startRoutes([
      {
        method: 'POST',
        match: (u) => u === '/graphql',
        status: 200,
        body: {data: {search: {nodes: []}}},
      },
    ])

    await expect(makeService(server.url).findUserByEmail('nobody@x.com')).resolves.toBeNull()
  })

  it('maps a single match to a GitHub user', async () => {
    const server = await startRoutes([
      {
        method: 'POST',
        match: (u) => u === '/graphql',
        status: 200,
        body: {data: {search: {nodes: [{__typename: 'User', login: 'ada'}]}}},
      },
    ])

    await expect(makeService(server.url).findUserByEmail('ada@x.com')).resolves.toEqual({
      login: 'ada',
      email: 'ada@x.com',
      type: 'User',
    })
  })

  it('rejects ambiguous matches with the candidate logins', async () => {
    const server = await startRoutes([
      {
        method: 'POST',
        match: (u) => u === '/graphql',
        status: 200,
        body: {
          data: {
            search: {
              nodes: [
                {__typename: 'User', login: 'ada'},
                {__typename: 'User', login: 'ada2'},
              ],
            },
          },
        },
      },
    ])

    const error = await captureError(makeService(server.url).findUserByEmail('ada@x.com'))

    expect(error).toBeInstanceOf(AmbiguousMatchError)
    expect((error as AmbiguousMatchError).candidates).toEqual(['ada', 'ada2'])
  })
})

describe('GitHubService.isUserSuspended', () => {
  it('is true when a suspension timestamp is present', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/users/ada',
        status: 200,
        body: {login: 'ada', suspended_at: '2026-07-01T00:00:00Z'},
      },
    ])

    await expect(makeService(server.url).isUserSuspended('ada')).resolves.toBe(true)
  })

  it('is false when no suspension timestamp is present', async () => {
    const server = await startRoutes([
      {method: 'GET', match: (u) => u === '/users/ada', status: 200, body: {login: 'ada'}},
    ])

    await expect(makeService(server.url).isUserSuspended('ada')).resolves.toBe(false)
  })
})

describe('GitHubService.getOrganizationBasePermission', () => {
  const cases: ReadonlyArray<readonly [string, 'none' | 'read' | 'write']> = [
    ['read', 'read'],
    ['write', 'write'],
    ['none', 'none'],
  ]
  for (const [permission, expected] of cases) {
    it(`maps default_repository_permission "${permission}" to "${expected}"`, async () => {
      const server = await startRoutes([
        {
          method: 'GET',
          match: (u) => u === '/orgs/acme',
          status: 200,
          body: {login: 'acme', default_repository_permission: permission},
        },
      ])

      await expect(makeService(server.url).getOrganizationBasePermission()).resolves.toBe(expected)
    })
  }

  it('rejects an unsupported base permission', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme',
        status: 200,
        body: {login: 'acme', default_repository_permission: 'frobnicate'},
      },
    ])

    await expect(makeService(server.url).getOrganizationBasePermission()).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('maps a 403 to a PermissionError', async () => {
    const server = await startRoutes([
      {method: 'GET', match: (u) => u === '/orgs/acme', status: 403, body: {message: 'Forbidden'}},
    ])

    const error = await captureError(makeService(server.url).getOrganizationBasePermission())

    expect(error).toBeInstanceOf(PermissionError)
  })
})

describe('GitHubService.getRepository', () => {
  it('returns full name, archived flag and explicit visibility', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/repos/acme/api',
        status: 200,
        body: {full_name: 'acme/api', archived: false, visibility: 'internal', private: true},
      },
    ])

    await expect(makeService(server.url).getRepository('acme/api')).resolves.toEqual({
      fullName: 'acme/api',
      archived: false,
      visibility: 'internal',
    })
  })

  it('falls back to private visibility when the field is absent but the repo is private', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/repos/acme/api',
        status: 200,
        body: {full_name: 'acme/api', archived: true, private: true},
      },
    ])

    await expect(makeService(server.url).getRepository('acme/api')).resolves.toEqual({
      fullName: 'acme/api',
      archived: true,
      visibility: 'private',
    })
  })

  it('maps a 404 to a NotFoundError', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/repos/acme/api',
        status: 404,
        body: {message: 'Not Found'},
      },
    ])

    const error = await captureError(makeService(server.url).getRepository('acme/api'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as NotFoundError).status).toBe(404)
  })

  it('rejects a malformed repository name before making a request', async () => {
    const server = await startRoutes([])

    await expect(makeService(server.url).getRepository('not-a-full-name')).rejects.toBeInstanceOf(
      ValidationError,
    )
    expect(server.requests).toHaveLength(0)
  })
})

describe('GitHubService.listTeamRepositories', () => {
  it('paginates and returns repository full names', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u.startsWith('/orgs/acme/teams/core/repos'),
        status: 200,
        body: [{full_name: 'acme/a'}, {full_name: 'acme/b'}],
      },
    ])

    await expect(makeService(server.url).listTeamRepositories('core')).resolves.toEqual([
      'acme/a',
      'acme/b',
    ])
  })

  it('maps a failure through the shared error translator', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u.startsWith('/orgs/acme/teams/core/repos'),
        status: 403,
        body: {message: 'Forbidden'},
      },
    ])

    await expect(makeService(server.url).listTeamRepositories('core')).rejects.toBeInstanceOf(
      PermissionError,
    )
  })
})

describe('GitHubService.isTeamIdpManaged', () => {
  it('is true when an external group is connected', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u.includes('/external-groups'),
        status: 200,
        body: {groups: [{group_id: 9}]},
      },
    ])

    await expect(makeService(server.url).isTeamIdpManaged('core')).resolves.toBe(true)
  })

  it('falls back to team synchronization and reports false when empty', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u.includes('/external-groups'),
        status: 404,
        body: {message: 'Not Found'},
      },
      {
        method: 'GET',
        match: (u) => u.includes('/team-sync/group-mappings'),
        status: 200,
        body: {groups: []},
      },
    ])

    await expect(makeService(server.url).isTeamIdpManaged('core')).resolves.toBe(false)
  })

  it('raises a PermissionError when both lookups are forbidden', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u.includes('/external-groups'),
        status: 403,
        body: {message: 'Forbidden'},
      },
      {
        method: 'GET',
        match: (u) => u.includes('/team-sync/group-mappings'),
        status: 403,
        body: {message: 'Forbidden'},
      },
    ])

    const error = await captureError(makeService(server.url).isTeamIdpManaged('core'))

    expect(error).toBeInstanceOf(PermissionError)
    expect((error as PermissionError).status).toBe(403)
  })

  it('rejects a malformed identity-provider payload', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u.includes('/external-groups'),
        status: 200,
        body: {groups: 'not-an-array'},
      },
    ])

    await expect(makeService(server.url).isTeamIdpManaged('core')).rejects.toBeInstanceOf(
      ValidationError,
    )
  })
})

describe('GitHubService.getTeamRepositoryPermission', () => {
  it('normalises an explicit role name', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/repos/acme/api',
        status: 200,
        body: {role_name: 'maintain', permissions: {}},
      },
    ])

    await expect(
      makeService(server.url).getTeamRepositoryPermission('core', 'acme/api'),
    ).resolves.toBe('maintain')
  })

  it('derives the role from the permissions map when no role name is present', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/repos/acme/api',
        status: 200,
        body: {permissions: {push: true, pull: true}},
      },
    ])

    await expect(
      makeService(server.url).getTeamRepositoryPermission('core', 'acme/api'),
    ).resolves.toBe('write')
  })

  it('returns null on a 404', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/repos/acme/api',
        status: 404,
        body: {message: 'Not Found'},
      },
    ])

    await expect(
      makeService(server.url).getTeamRepositoryPermission('core', 'acme/api'),
    ).resolves.toBeNull()
  })

  it('rejects an unsupported custom role name', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/repos/acme/api',
        status: 200,
        body: {role_name: 'frobnicate'},
      },
    ])

    await expect(
      makeService(server.url).getTeamRepositoryPermission('core', 'acme/api'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a response with neither a role name nor recognised permissions', async () => {
    const server = await startRoutes([
      {
        method: 'GET',
        match: (u) => u === '/orgs/acme/teams/core/repos/acme/api',
        status: 200,
        body: {permissions: {}},
      },
    ])

    await expect(
      makeService(server.url).getTeamRepositoryPermission('core', 'acme/api'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a malformed repository name before making a request', async () => {
    const server = await startRoutes([])

    await expect(
      makeService(server.url).getTeamRepositoryPermission('core', 'bad'),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(server.requests).toHaveLength(0)
  })
})

describe('GitHubService.setTeamRepositoryPermission', () => {
  const mappings: ReadonlyArray<readonly ['read' | 'write' | 'admin', string]> = [
    ['write', 'push'],
    ['read', 'pull'],
    ['admin', 'admin'],
  ]
  for (const [role, apiPermission] of mappings) {
    it(`sends the "${apiPermission}" permission for role "${role}"`, async () => {
      const server = await startRoutes([
        {method: 'PUT', match: (u) => u === '/orgs/acme/teams/core/repos/acme/api', status: 204},
      ])

      await expect(
        makeService(server.url).setTeamRepositoryPermission('core', 'acme/api', role),
      ).resolves.toBeUndefined()
      const put = server.requests.find((request) => request.method === 'PUT')
      expect(parseJson(put?.body)).toEqual({permission: apiPermission})
    })
  }

  it('maps a failure through the shared error translator', async () => {
    const server = await startRoutes([
      {
        method: 'PUT',
        match: (u) => u === '/orgs/acme/teams/core/repos/acme/api',
        status: 403,
        body: {message: 'Forbidden'},
      },
    ])

    await expect(
      makeService(server.url).setTeamRepositoryPermission('core', 'acme/api', 'write'),
    ).rejects.toBeInstanceOf(PermissionError)
  })
})
