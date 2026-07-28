import path from 'node:path'
import {describe, expect, it} from 'vitest'
type PactV3Type = typeof import('@pact-foundation/pact').PactV3

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

async function githubProvider(testName: string): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: `ado-to-github-teams-${testName}`,
    provider: 'github-api',
    dir: path.resolve('test/contract/pacts'),
  })
}

contractDescribe('GitHub consumer contracts', () => {
  it('GET org teams success pagination and auth failures', async () => {
    const success = await githubProvider('github-org-teams-success')
    success
      .addInteraction({
        uponReceiving: 'teams page one',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams',
          query: {per_page: '100', page: '1'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: [{id: 1, slug: 'core', name: 'Core', privacy: 'closed'}],
        },
      })
      .addInteraction({
        uponReceiving: 'teams page two',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams',
          query: {per_page: '100', page: '2'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: [],
        },
      })

    await success.executeTest(async (mockserver) => {
      const page1 = await fetch(`${mockserver.url}/orgs/contoso/teams?per_page=100&page=1`)
      const page2 = await fetch(`${mockserver.url}/orgs/contoso/teams?per_page=100&page=2`)
      expect(page1.status).toBe(200)
      expect(page2.status).toBe(200)
    })

    for (const status of [401, 404]) {
      const provider = await githubProvider(`github-org-teams-${status}`)
      provider.addInteraction({
        uponReceiving: `org teams returns ${status}`,
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams',
          query: {per_page: '100', page: '1'},
        },
        willRespondWith: {status, body: {message: `HTTP ${status}`}},
      })
      await provider.executeTest(async (mockserver) => {
        const response = await fetch(`${mockserver.url}/orgs/contoso/teams?per_page=100&page=1`)
        expect(response.status).toBe(status)
      })
    }

    const sso = await githubProvider('github-org-teams-sso')
    sso.addInteraction({
      uponReceiving: 'org teams blocked by sso',
      withRequest: {
        method: 'GET',
        path: '/orgs/contoso/teams',
        query: {per_page: '100', page: '1'},
      },
      willRespondWith: {
        status: 403,
        headers: {'x-github-sso': 'required; url=https://github.com/orgs/contoso/sso'},
        body: {message: 'SSO required'},
      },
    })
    await sso.executeTest(async (mockserver) => {
      const response = await fetch(`${mockserver.url}/orgs/contoso/teams?per_page=100&page=1`)
      expect(response.status).toBe(403)
      expect(response.headers.get('x-github-sso')).toContain('required')
    })
  })

  it('GET team by slug found and not found', async () => {
    const provider = await githubProvider('github-team-slug')
    provider
      .addInteraction({
        uponReceiving: 'fetch team by slug',
        withRequest: {method: 'GET', path: '/orgs/contoso/teams/core'},
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {id: 1, slug: 'core', name: 'Core', privacy: 'closed'},
        },
      })
      .addInteraction({
        uponReceiving: 'fetch missing team by slug',
        withRequest: {method: 'GET', path: '/orgs/contoso/teams/missing'},
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Not found'},
        },
      })

    await provider.executeTest(async (mockserver) => {
      const found = await fetch(`${mockserver.url}/orgs/contoso/teams/core`)
      const missing = await fetch(`${mockserver.url}/orgs/contoso/teams/missing`)
      expect(found.status).toBe(200)
      expect(missing.status).toBe(404)
    })
  })

  it('POST create team success and 422 conflict', async () => {
    const provider = await githubProvider('github-create-team')
    provider
      .addInteraction({
        uponReceiving: 'create team request',
        withRequest: {
          method: 'POST',
          path: '/orgs/contoso/teams',
          headers: {'Content-Type': 'application/json'},
          body: {name: 'Core'},
        },
        willRespondWith: {
          status: 201,
          headers: {'Content-Type': 'application/json'},
          body: {id: 2, slug: 'core', name: 'Core', privacy: 'closed'},
        },
      })
      .addInteraction({
        uponReceiving: 'conflicting create team request',
        withRequest: {
          method: 'POST',
          path: '/orgs/contoso/teams',
          headers: {'Content-Type': 'application/json'},
          body: {name: 'Core'},
        },
        willRespondWith: {
          status: 422,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Validation Failed'},
        },
      })

    await provider.executeTest(async (mockserver) => {
      const created = await fetch(`${mockserver.url}/orgs/contoso/teams`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'Core'}),
      })
      const conflict = await fetch(`${mockserver.url}/orgs/contoso/teams`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'Core'}),
      })
      expect(created.status).toBe(201)
      expect(conflict.status).toBe(422)
    })
  })

  it('PUT add member success, not found, and suspended 422', async () => {
    const provider = await githubProvider('github-add-member')
    provider
      .addInteraction({
        uponReceiving: 'add member success',
        withRequest: {method: 'PUT', path: '/orgs/contoso/teams/core/memberships/ada'},
        willRespondWith: {status: 200, body: {state: 'active'}},
      })
      .addInteraction({
        uponReceiving: 'add member missing user',
        withRequest: {method: 'PUT', path: '/orgs/contoso/teams/core/memberships/missing'},
        willRespondWith: {status: 404, body: {message: 'Not found'}},
      })
      .addInteraction({
        uponReceiving: 'add suspended user',
        withRequest: {method: 'PUT', path: '/orgs/contoso/teams/core/memberships/suspended'},
        willRespondWith: {status: 422, body: {message: 'Validation Failed'}},
      })

    await provider.executeTest(async (mockserver) => {
      const ok = await fetch(`${mockserver.url}/orgs/contoso/teams/core/memberships/ada`, {
        method: 'PUT',
      })
      const missing = await fetch(
        `${mockserver.url}/orgs/contoso/teams/core/memberships/missing`,
        {method: 'PUT'},
      )
      const suspended = await fetch(
        `${mockserver.url}/orgs/contoso/teams/core/memberships/suspended`,
        {method: 'PUT'},
      )
      expect(ok.status).toBe(200)
      expect(missing.status).toBe(404)
      expect(suspended.status).toBe(422)
    })
  })

  it('GET user by email found and not found', async () => {
    const provider = await githubProvider('github-user-email')
    provider
      .addInteraction({
        uponReceiving: 'search users by email found',
        withRequest: {
          method: 'GET',
          path: '/search/users',
          query: {q: 'ada@contoso.com in:email org:contoso', per_page: '10'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {items: [{login: 'ada', type: 'User'}]},
        },
      })
      .addInteraction({
        uponReceiving: 'search users by email missing',
        withRequest: {
          method: 'GET',
          path: '/search/users',
          query: {q: 'missing@contoso.com in:email org:contoso', per_page: '10'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {items: []},
        },
      })

    await provider.executeTest(async (mockserver) => {
      const found = await fetch(
        `${mockserver.url}/search/users?q=${encodeURIComponent(
          'ada@contoso.com in:email org:contoso',
        )}&per_page=10`,
      )
      const missing = await fetch(
        `${mockserver.url}/search/users?q=${encodeURIComponent(
          'missing@contoso.com in:email org:contoso',
        )}&per_page=10`,
      )
      expect(found.status).toBe(200)
      expect(missing.status).toBe(200)
    })
  })
})
