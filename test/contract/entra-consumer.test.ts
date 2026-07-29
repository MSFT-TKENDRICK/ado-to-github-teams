import path from 'node:path'
import {Client} from '@microsoft/microsoft-graph-client'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {ResolvedCredentials} from '../../src/auth/manager.js'
import {makeEntraLayer} from '../../src/effect/layers.js'
import {EntraServiceTag, type EntraServiceFx} from '../../src/effect/services.js'

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe.sequential : describe.skip
const authorization = 'Bearer contract-token'
const credentials: ResolvedCredentials = {
  adoPat: 'unused',
  adoTokenType: 'pat',
  githubPat: 'unused',
  entraClientId: 'contract-client',
  entraClientSecret: 'contract-secret',
  entraClientTenantId: 'contract-tenant',
}
const memberSelect = 'id,displayName,userPrincipalName,mail,accountEnabled,userType'
const nestedMemberSelect = `${memberSelect},@odata.type`
const graphNextLink = `https://graph.microsoft.com/v1.0/groups/g1/members?$select=${encodeURIComponent(memberSelect)}&$skiptoken=opaque-next`

async function entraProvider() {
  const {MatchersV3, PactV3} = await import('@pact-foundation/pact')
  return {
    matchers: MatchersV3,
    provider: new PactV3({
      consumer: 'ado-to-github-teams',
      provider: 'microsoft-graph',
      dir: path.resolve('test/contract/pacts'),
    }),
  }
}

function graphClient(providerUrl: string): Client {
  return Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => 'contract-token',
    },
    baseUrl: providerUrl,
    defaultVersion: 'v1.0',
  })
}

function runEntra<A>(
  providerUrl: string,
  use: (service: EntraServiceFx) => Effect.Effect<A, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* EntraServiceTag
      return yield* use(service)
    }).pipe(
      Effect.provide(
        makeEntraLayer(credentials, graphClient(providerUrl), `${providerUrl}/v1.0`),
      ),
    ),
  )
}

contractDescribe('Microsoft Graph consumer contracts', () => {
  it('loads all group member pages through the production Effect layer', async () => {
    const {matchers, provider} = await entraProvider()
    provider
      .addInteraction({
        uponReceiving: 'the first Microsoft Graph group members page',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/g1/members',
          query: {'$select': memberSelect},
          headers: {Authorization: authorization},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: matchers.atLeastLike(
              {
                id: matchers.string('u1'),
                displayName: matchers.string('Ada'),
                userPrincipalName: matchers.string('ada@contoso.com'),
                mail: matchers.string('ada@contoso.com'),
                accountEnabled: matchers.boolean(true),
                userType: matchers.regex('^(Member|Guest)$', 'Member'),
              },
              0,
              1,
            ),
            '@odata.nextLink': matchers.string(graphNextLink),
          },
        },
      })
      .addInteraction({
        uponReceiving: 'the next Microsoft Graph group members page',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/g1/members',
          query: {'$select': memberSelect, '$skiptoken': 'opaque-next'},
          headers: {Authorization: authorization},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: matchers.atLeastLike(
              {
                id: matchers.string('u2'),
                displayName: matchers.string('Grace'),
                userPrincipalName: matchers.string('grace@contoso.com'),
                userType: matchers.regex('^(Member|Guest)$', 'Guest'),
              },
              0,
              1,
            ),
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runEntra(mockserver.url, (service) => service.getGroupMembers('g1')),
      ).resolves.toEqual([
        {
          id: 'u1',
          displayName: 'Ada',
          userPrincipalName: 'ada@contoso.com',
          mail: 'ada@contoso.com',
          accountEnabled: true,
          isGuest: false,
        },
        {
          id: 'u2',
          displayName: 'Grace',
          userPrincipalName: 'grace@contoso.com',
          isGuest: true,
        },
      ])
    })
  })

  it('expands nested groups using the production recursive request sequence', async () => {
    const {matchers, provider} = await entraProvider()
    provider
      .addInteraction({
        uponReceiving: 'a Microsoft Graph parent group members request',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/parent/members',
          query: {'$select': nestedMemberSelect},
          headers: {Authorization: authorization},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: matchers.atLeastLike(
              {
                id: matchers.string('child'),
                displayName: matchers.string('Child Group'),
                '@odata.type': '#microsoft.graph.group',
              },
              0,
              1,
            ),
          },
        },
      })
      .addInteraction({
        uponReceiving: 'a Microsoft Graph nested group members request',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/child/members',
          query: {'$select': nestedMemberSelect},
          headers: {Authorization: authorization},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: matchers.atLeastLike(
              {
                id: matchers.string('u1'),
                displayName: matchers.string('Ada'),
                userPrincipalName: matchers.string('ada@contoso.com'),
                '@odata.type': '#microsoft.graph.user',
              },
              0,
              1,
            ),
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runEntra(mockserver.url, (service) => service.getGroupMembers('parent', true)),
      ).resolves.toEqual([
        {
          id: 'u1',
          displayName: 'Ada',
          userPrincipalName: 'ada@contoso.com',
          isGuest: false,
        },
      ])
    })
  })

  it('resolves a user by UPN and maps the Graph response', async () => {
    const {matchers, provider} = await entraProvider()
    provider.addInteraction({
      uponReceiving: 'a Microsoft Graph user lookup by UPN',
      withRequest: {
        method: 'GET',
        path: '/v1.0/users/ada%40contoso.com',
        query: {'$select': memberSelect},
        headers: {Authorization: authorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          id: matchers.string('u1'),
          displayName: matchers.string('Ada'),
          userPrincipalName: matchers.string('ada@contoso.com'),
          mail: matchers.string('ada@contoso.com'),
          accountEnabled: matchers.boolean(true),
          userType: matchers.regex('^(Member|Guest)$', 'Member'),
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runEntra(mockserver.url, (service) => service.resolveUserByUpn('ada@contoso.com')),
      ).resolves.toEqual({
        id: 'u1',
        displayName: 'Ada',
        userPrincipalName: 'ada@contoso.com',
        mail: 'ada@contoso.com',
        accountEnabled: true,
        isGuest: false,
      })
    })
  })

  it('maps Graph permission failures at the Effect boundary', async () => {
    const {matchers, provider} = await entraProvider()
    provider.addInteraction({
      uponReceiving: 'a forbidden Microsoft Graph group members request',
      withRequest: {
        method: 'GET',
        path: '/v1.0/groups/g1/members',
        query: {'$select': memberSelect},
        headers: {Authorization: authorization},
      },
      willRespondWith: {
        status: 403,
        headers: {'Content-Type': 'application/json'},
        body: {
          error: {
            code: matchers.string('Authorization_RequestDenied'),
            message: matchers.string('Forbidden'),
          },
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runEntra(mockserver.url, (service) => service.getGroupMembers('g1')),
      ).rejects.toMatchObject({
        _tag: 'PermissionFailure',
        status: 403,
      })
    })
  })
})
