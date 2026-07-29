import path from 'node:path'
import {Client} from '@microsoft/microsoft-graph-client'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {PactV3 as PactV3Class} from '@pact-foundation/pact'
import type {TokenCredential} from '@azure/identity'
import type {ResolvedCredentials} from '../../src/auth/manager.js'
import {makeEntraLayer} from '../../src/effect/layers.js'
import {EntraServiceTag, type EntraServiceFx} from '../../src/effect/services.js'

/**
 * Consumer-side boundary-shape checks, NOT Microsoft Graph provider verification.
 *
 * These specs run the production Microsoft Graph adapter against a Pact
 * mock server to catch accidental drift in the requests we send and the
 * responses we parse (select clauses, paging, odata type discrimination).
 * We do not own the Microsoft Graph API, so it cannot be provider-verified
 * from this repository. A green run here proves our adapter matches the
 * shape it was written against; it is NOT evidence of live compatibility
 * with the real service and these pacts must never be published to a
 * broker or cited as `can-i-deploy` evidence for Microsoft Graph.
 *
 * Validate real drift with a controlled, human-reviewed run against a
 * non-production Entra tenant whenever the adapter or the targeted Graph
 * API version changes (see "Third-party contract coverage" in README.md).
 */

type PactV3Type = typeof PactV3Class

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe.sequential : describe.skip
const ambientCredential: TokenCredential = {
  getToken: async () => ({token: 'contract-token', expiresOnTimestamp: Date.now() + 60_000}),
}
const credentials: ResolvedCredentials = {
  ado: {kind: 'entra', credential: ambientCredential, source: 'ambient'},
  githubToken: 'unused',
  githubSource: 'environment',
  entraCredential: ambientCredential,
  entraScopes: ['https://graph.microsoft.com/.default'],
}
const memberSelect = 'id,displayName,userPrincipalName,mail,accountEnabled,userType'
const nestedMemberSelect = `${memberSelect},@odata.type`

async function entraProvider(): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: 'ado-to-github-teams',
    provider: 'microsoft-graph',
    dir: path.resolve('test/contract/pacts'),
  })
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

contractDescribe('Microsoft Graph consumer boundary-shape checks (not provider-verified)', () => {
  it('loads all group member pages through the production Effect layer', async () => {
    const provider = await entraProvider()
    provider
      .addInteraction({
        uponReceiving: 'the first Microsoft Graph group members page',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/g1/members',
          query: {'$select': memberSelect},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: [
              {
                id: 'u1',
                displayName: 'Ada',
                userPrincipalName: 'ada@contoso.com',
                mail: 'ada@contoso.com',
                accountEnabled: true,
                userType: 'Member',
              },
            ],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/groups/g1/members?$skiptoken=next',
          },
        },
      })
      .addInteraction({
        uponReceiving: 'the next Microsoft Graph group members page',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/g1/members',
          query: {'$skiptoken': 'next'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: [
              {
                id: 'u2',
                displayName: 'Grace',
                userPrincipalName: 'grace@contoso.com',
                userType: 'Guest',
              },
            ],
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
    const provider = await entraProvider()
    provider
      .addInteraction({
        uponReceiving: 'a Microsoft Graph parent group members request',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/parent/members',
          query: {'$select': nestedMemberSelect},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: [
              {
                id: 'child',
                displayName: 'Child Group',
                '@odata.type': '#microsoft.graph.group',
              },
            ],
          },
        },
      })
      .addInteraction({
        uponReceiving: 'a Microsoft Graph nested group members request',
        withRequest: {
          method: 'GET',
          path: '/v1.0/groups/child/members',
          query: {'$select': nestedMemberSelect},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            value: [
              {
                id: 'u1',
                displayName: 'Ada',
                userPrincipalName: 'ada@contoso.com',
                '@odata.type': '#microsoft.graph.user',
              },
            ],
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
    const provider = await entraProvider()
    provider.addInteraction({
      uponReceiving: 'a Microsoft Graph user lookup by UPN',
      withRequest: {
        method: 'GET',
        path: '/v1.0/users/ada%40contoso.com',
        query: {'$select': memberSelect},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          id: 'u1',
          displayName: 'Ada',
          userPrincipalName: 'ada@contoso.com',
          mail: 'ada@contoso.com',
          accountEnabled: true,
          userType: 'Member',
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
    const provider = await entraProvider()
    provider.addInteraction({
      uponReceiving: 'a forbidden Microsoft Graph group members request',
      withRequest: {
        method: 'GET',
        path: '/v1.0/groups/g1/members',
        query: {'$select': memberSelect},
      },
      willRespondWith: {
        status: 403,
        headers: {'Content-Type': 'application/json'},
        body: {error: {code: 'Authorization_RequestDenied', message: 'Forbidden'}},
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
