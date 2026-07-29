import path from 'node:path'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {ResolvedCredentials} from '../../src/auth/manager.js'
import {validateAdoCredential} from '../../src/auth/validate.js'
import {makeAdoLayer} from '../../src/effect/layers.js'
import {AdoServiceTag} from '../../src/effect/services.js'

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe.sequential : describe.skip
const bearerToken = 'header.payload.signature'
const bearerAuthorization = `Bearer ${bearerToken}`
const credentialAuthorization = `Basic ${Buffer.from(':contract-token').toString('base64')}`
const serviceAuthorization = `Basic ${Buffer.from('PAT:contract-token').toString('base64')}`
const credentials: ResolvedCredentials = {
  adoPat: 'contract-token',
  adoTokenType: 'pat',
  githubPat: 'unused',
  entraClientId: 'unused',
  entraClientSecret: 'unused',
  entraClientTenantId: 'unused',
}
const bearerCredentials: ResolvedCredentials = {
  ...credentials,
  adoPat: bearerToken,
  adoTokenType: 'bearer',
}

async function adoProvider() {
  const {MatchersV3, PactV3} = await import('@pact-foundation/pact')
  return {
    matchers: MatchersV3,
    provider: new PactV3({
      consumer: 'ado-to-github-teams',
      provider: 'azure-devops',
      dir: path.resolve('test/contract/pacts'),
    }),
  }
}

function runAdo<A>(
  providerUrl: string,
  use: (service: typeof AdoServiceTag.Service) => Effect.Effect<A, unknown>,
  testCredentials = credentials,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AdoServiceTag
      return yield* use(service)
    }).pipe(Effect.provide(makeAdoLayer(testCredentials, providerUrl))),
  )
}

contractDescribe('Azure DevOps consumer contracts', () => {
  it('validates a PAT with the production credential request', async () => {
    const {matchers, provider} = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'an Azure DevOps credential validation request',
      withRequest: {
        method: 'GET',
        path: '/_apis/connectionData',
        query: {
          connectOptions: 'none',
          lastChangeId: '-1',
          lastChangeId64: '-1',
        },
        headers: {Authorization: credentialAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {authenticatedUser: {id: matchers.string('u1')}},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(validateAdoCredential('contract-token', mockserver.url)).resolves.toBeUndefined()
    })
  })

  it('validates a device-flow token with Bearer authentication', async () => {
    const {matchers, provider} = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'an Azure DevOps Bearer credential validation request',
      withRequest: {
        method: 'GET',
        path: '/_apis/connectionData',
        query: {
          connectOptions: 'none',
          lastChangeId: '-1',
          lastChangeId64: '-1',
        },
        headers: {Authorization: bearerAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {authenticatedUser: {id: matchers.string('u1')}},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        validateAdoCredential(bearerToken, mockserver.url, 'bearer'),
      ).resolves.toBeUndefined()
    })
  })

  it('loads project teams with Bearer authentication through the production Effect layer', async () => {
    const {matchers, provider} = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'an Azure DevOps Bearer-authenticated project teams request',
      withRequest: {
        method: 'GET',
        path: '/_apis/projects/Platform/teams',
        query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        headers: {Authorization: bearerAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          count: matchers.integer(1),
          value: matchers.atLeastLike(
            {
              id: matchers.string('t1'),
              name: matchers.string('Platform Team'),
              projectId: matchers.string('p1'),
              projectName: matchers.string('Platform'),
            },
            0,
            1,
          ),
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runAdo(mockserver.url, (service) => service.getTeams('Platform'), bearerCredentials),
      ).resolves.toEqual([
        {
          id: 't1',
          name: 'Platform Team',
          projectId: 'p1',
          projectName: 'Platform',
        },
      ])
    })
  })

  it('loads every project team page through the production Effect layer', async () => {
    const {matchers, provider} = await adoProvider()
    provider
      .addInteraction({
        uponReceiving: 'the first project teams page',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/Platform/teams',
          query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
          headers: {Authorization: serviceAuthorization},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            count: matchers.integer(100),
            value: matchers.atLeastLike(
              {
                id: matchers.string('t0'),
                name: matchers.string('Team 0'),
                projectId: matchers.string('p1'),
                projectName: matchers.string('Platform'),
              },
              0,
              100,
            ),
          },
        },
      })
      .addInteraction({
        uponReceiving: 'the final project teams page',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/Platform/teams',
          query: {'api-version': '7.1-preview.3', '$skip': '100', '$top': '100'},
          headers: {Authorization: serviceAuthorization},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            count: matchers.integer(1),
            value: matchers.atLeastLike(
              {
                id: matchers.string('t100'),
                name: matchers.string('Team 100'),
                projectId: matchers.string('p1'),
                projectName: matchers.string('Platform'),
              },
              0,
              1,
            ),
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      const teams = await runAdo(mockserver.url, (service) => service.getTeams('Platform'))
      expect(teams).toHaveLength(101)
      expect(teams[0]).toMatchObject({id: 't0', name: 'Team 0'})
      expect(teams[100]).toMatchObject({id: 't100', name: 'Team 100'})
    })
  })

  it('loads and maps team members through the production Effect layer', async () => {
    const {matchers, provider} = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'a team members page',
      withRequest: {
        method: 'GET',
        path: '/_apis/projects/p1/teams/t1/members',
        query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        headers: {Authorization: serviceAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          count: matchers.integer(1),
          value: matchers.atLeastLike(
            {
              identity: {
                id: matchers.string('u1'),
                displayName: matchers.string('Ada'),
                uniqueName: matchers.string('ada@contoso.com'),
                mailAddress: matchers.string('ada@contoso.com'),
                descriptor: matchers.string('aad.u1'),
                isContainer: matchers.boolean(false),
              },
            },
            0,
            1,
          ),
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runAdo(mockserver.url, (service) => service.getTeamMembers('p1', 't1')),
      ).resolves.toEqual([
        {
          id: 'u1',
          displayName: 'Ada',
          uniqueName: 'ada@contoso.com',
          email: 'ada@contoso.com',
          descriptor: 'aad.u1',
          isContainer: false,
        },
      ])
    })
  })

  it('resolves an ADO group descriptor to its Entra origin id', async () => {
    const {matchers, provider} = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'an ADO graph group lookup',
      withRequest: {
        method: 'GET',
        path: '/_apis/graph/groups/vssgp.Uy0x',
        query: {'api-version': '7.1-preview.1'},
        headers: {Authorization: serviceAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {originId: matchers.string('entra-group-id')},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runAdo(mockserver.url, (service) => service.resolveGroupOriginId('vssgp.Uy0x')),
      ).resolves.toBe('entra-group-id')
    })
  })

  it('maps provider authorization failures at the Effect boundary', async () => {
    const {matchers, provider} = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'a forbidden project teams request',
      withRequest: {
        method: 'GET',
        path: '/_apis/projects/Platform/teams',
        query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        headers: {Authorization: serviceAuthorization},
      },
      willRespondWith: {
        status: 403,
        headers: {'Content-Type': 'application/json'},
        body: {message: matchers.string('Forbidden')},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(runAdo(mockserver.url, (service) => service.getTeams('Platform'))).rejects.toThrow(
        'ADO permission denied',
      )
    })
  })
})
