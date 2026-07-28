import path from 'node:path'
import {describe, expect, it} from 'vitest'
type PactV3Type = typeof import('@pact-foundation/pact').PactV3

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

async function entraProvider(testName: string): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: `ado-to-github-teams-${testName}`,
    provider: 'microsoft-graph',
    dir: path.resolve('test/contract/pacts'),
  })
}

contractDescribe('Entra consumer contracts', () => {
  it('GET group members supports nextLink pagination', async () => {
    const provider = await entraProvider('entra-group-members-pagination')
    provider
      .addInteraction({
        uponReceiving: 'group members first page',
        withRequest: {
          method: 'GET',
          path: '/groups/g1/members',
          query: {'$select': 'id,displayName,userPrincipalName,mail,accountEnabled,userType'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: [{id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@contoso.com'}],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/groups/g1/members?$skiptoken=next',
          },
        },
      })
      .addInteraction({
        uponReceiving: 'group members second page',
        withRequest: {
          method: 'GET',
          path: '/groups/g1/members',
          query: {'$skiptoken': 'next'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: [{id: 'u2', displayName: 'Grace', userPrincipalName: 'grace@contoso.com'}],
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      const first = await fetch(
        `${mockserver.url}/groups/g1/members?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`,
      )
      const second = await fetch(`${mockserver.url}/groups/g1/members?$skiptoken=next`)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
    })
  })

  it('GET group members failure statuses', async () => {
    for (const status of [401, 403, 404, 429]) {
      const provider = await entraProvider(`entra-group-members-${status}`)
      provider.addInteraction({
        uponReceiving: `group members returns ${status}`,
        withRequest: {
          method: 'GET',
          path: '/groups/g1/members',
          query: {'$select': 'id,displayName,userPrincipalName,mail,accountEnabled,userType'},
        },
        willRespondWith: {
          status,
          headers: {'Content-Type': 'application/json'},
          body: {error: {code: `${status}`, message: `HTTP ${status}`}},
        },
      })

      await provider.executeTest(async (mockserver) => {
        const response = await fetch(
          `${mockserver.url}/groups/g1/members?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`,
        )
        expect(response.status).toBe(status)
      })
    }
  })

  it('GET transitive members success', async () => {
    const provider = await entraProvider('entra-transitive-members')
    provider.addInteraction({
      uponReceiving: 'transitive members request',
      withRequest: {
        method: 'GET',
        path: '/groups/g1/transitiveMembers',
        query: {'$select': 'id,displayName,userPrincipalName,mail,accountEnabled,userType'},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          value: [{id: 'u1', displayName: 'Ada', userPrincipalName: 'ada@contoso.com'}],
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      const response = await fetch(
        `${mockserver.url}/groups/g1/transitiveMembers?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`,
      )
      expect(response.status).toBe(200)
    })
  })

  it('GET user by UPN success, not found, and guest shape', async () => {
    const provider = await entraProvider('entra-user-upn')
    provider
      .addInteraction({
        uponReceiving: 'user lookup success',
        withRequest: {
          method: 'GET',
          path: '/users/ada%40contoso.com',
          query: {'$select': 'id,displayName,userPrincipalName,mail,accountEnabled,userType'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            id: 'u1',
            displayName: 'Ada',
            userPrincipalName: 'ada@contoso.com',
            mail: 'ada@contoso.com',
            userType: 'Member',
          },
        },
      })
      .addInteraction({
        uponReceiving: 'user lookup not found',
        withRequest: {
          method: 'GET',
          path: '/users/missing%40contoso.com',
          query: {'$select': 'id,displayName,userPrincipalName,mail,accountEnabled,userType'},
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {error: {code: 'Request_ResourceNotFound'}},
        },
      })
      .addInteraction({
        uponReceiving: 'guest user lookup',
        withRequest: {
          method: 'GET',
          path: '/users/guest%40contoso.com',
          query: {'$select': 'id,displayName,userPrincipalName,mail,accountEnabled,userType'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            id: 'u2',
            displayName: 'Guest User',
            userPrincipalName: 'guest@contoso.com',
            userType: 'Guest',
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      const found = await fetch(
        `${mockserver.url}/users/ada%40contoso.com?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`,
      )
      const missing = await fetch(
        `${mockserver.url}/users/missing%40contoso.com?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`,
      )
      const guest = await fetch(
        `${mockserver.url}/users/guest%40contoso.com?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType`,
      )
      expect(found.status).toBe(200)
      expect(missing.status).toBe(404)
      expect(guest.status).toBe(200)
    })
  })
})
