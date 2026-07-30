import path from 'node:path'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {PactV3 as PactV3Class} from '@pact-foundation/pact'
import type {TokenCredential} from '@azure/identity'
import type {ResolvedCredentials} from '../../src/auth/manager.js'
import {validateAdoCredential} from '../../src/auth/validate.js'
import {makeAdoLayer} from '../../src/effect/layers.js'
import {AdoServiceTag} from '../../src/effect/services.js'

/**
 * Consumer-side boundary-shape checks, NOT Azure DevOps provider verification.
 *
 * These specs run the production Azure DevOps adapter against a Pact mock
 * server to catch accidental drift in the requests we send and the
 * responses we parse (paths, query parameters, headers, status handling).
 * We do not own the Azure DevOps API, so it cannot be provider-verified
 * from this repository. A green run here proves our adapter matches the
 * shape it was written against; it is NOT evidence of live compatibility
 * with the real service and these pacts must never be published to a
 * broker or cited as `can-i-deploy` evidence for Azure DevOps.
 *
 * Validate real drift with a controlled, human-reviewed run against a
 * non-production Azure DevOps organization whenever the adapter or the
 * targeted REST API version changes (see "Contract tests" in
 * docs/testing.md).
 */

type PactV3Type = typeof PactV3Class

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe.sequential : describe.skip
const ambientCredential: TokenCredential = {
  getToken: async () => ({token: 'unused', expiresOnTimestamp: Date.now() + 60_000}),
}
const credentials: ResolvedCredentials = {
  ado: {kind: 'pat', token: 'contract-token', source: 'environment'},
  githubToken: 'unused',
  githubSource: 'environment',
  entraCredential: ambientCredential,
  entraScopes: ['https://graph.microsoft.com/.default'],
}

async function adoProvider(): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: 'ado-to-github-teams',
    provider: 'azure-devops',
    dir: path.resolve('test/contract/pacts'),
  })
}

function runAdo<A>(
  providerUrl: string,
  use: (service: typeof AdoServiceTag.Service) => Effect.Effect<A, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* AdoServiceTag
      return yield* use(service)
    }).pipe(Effect.provide(makeAdoLayer(credentials, providerUrl))),
  )
}

contractDescribe('Azure DevOps consumer boundary-shape checks (not provider-verified)', () => {
  it('validates a PAT with the production credential request', async () => {
    const provider = await adoProvider()
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
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {authenticatedUser: {id: 'u1'}},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        validateAdoCredential(
          {kind: 'pat', token: 'contract-token', source: 'environment'},
          mockserver.url,
        ),
      ).resolves.toBeUndefined()
    })
  })

  it('loads every project team page through the production Effect layer', async () => {
    const provider = await adoProvider()
    const firstPage = Array.from({length: 100}, (_, index) => ({
      id: `t${index}`,
      name: `Team ${index}`,
      projectId: 'p1',
      projectName: 'Platform',
    }))
    provider
      .addInteraction({
        uponReceiving: 'the first project teams page',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/Platform/teams',
          query: {'api-version': '7.1-preview.3', $skip: '0', $top: '100'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            count: 100,
            value: firstPage,
          },
        },
      })
      .addInteraction({
        uponReceiving: 'the final project teams page',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/Platform/teams',
          query: {'api-version': '7.1-preview.3', $skip: '100', $top: '100'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            count: 1,
            value: [
              {
                id: 't100',
                name: 'Team 100',
                projectId: 'p1',
                projectName: 'Platform',
              },
            ],
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
    const provider = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'a team members page',
      withRequest: {
        method: 'GET',
        path: '/_apis/projects/p1/teams/t1/members',
        query: {'api-version': '7.1-preview.3', $skip: '0', $top: '100'},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          count: 1,
          value: [
            {
              identity: {
                id: 'u1',
                displayName: 'Ada',
                uniqueName: 'ada@contoso.com',
                mailAddress: 'ada@contoso.com',
                descriptor: 'aad.u1',
                isContainer: false,
              },
            },
          ],
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
    const provider = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'an ADO graph group lookup',
      withRequest: {
        method: 'GET',
        path: '/_apis/graph/groups/vssgp.Uy0x',
        query: {'api-version': '7.1-preview.1'},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {originId: 'entra-group-id'},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runAdo(mockserver.url, (service) => service.resolveGroupOriginId('vssgp.Uy0x')),
      ).resolves.toBe('entra-group-id')
    })
  })

  it('maps provider authorization failures at the Effect boundary', async () => {
    const provider = await adoProvider()
    provider.addInteraction({
      uponReceiving: 'a forbidden project teams request',
      withRequest: {
        method: 'GET',
        path: '/_apis/projects/Platform/teams',
        query: {'api-version': '7.1-preview.3', $skip: '0', $top: '100'},
      },
      willRespondWith: {
        status: 403,
        headers: {'Content-Type': 'application/json'},
        body: {message: 'Forbidden'},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runAdo(mockserver.url, (service) => service.getTeams('Platform')),
      ).rejects.toThrow('ADO permission denied')
    })
  })
})
