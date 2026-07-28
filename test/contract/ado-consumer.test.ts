import path from 'node:path'
import {describe, expect, it} from 'vitest'
type PactV3Type = typeof import('@pact-foundation/pact').PactV3

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe : describe.skip

async function adoProvider(testName: string): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: `ado-to-github-teams-${testName}`,
    provider: 'azure-devops',
    dir: path.resolve('test/contract/pacts'),
  })
}

contractDescribe('ADO consumer contracts', () => {
  it('GET teams success with pagination', async () => {
    const provider = await adoProvider('ado-teams-success')
    provider
      .addInteraction({
        uponReceiving: 'first teams page',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/Platform/teams',
          query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            count: 1,
            value: [{id: 't1', name: 'Core', projectId: 'p1', projectName: 'Platform'}],
          },
        },
      })
      .addInteraction({
        uponReceiving: 'second teams page',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/Platform/teams',
          query: {'api-version': '7.1-preview.3', '$skip': '100', '$top': '100'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {count: 0, value: []},
        },
      })

    await provider.executeTest(async (mockserver) => {
      const first = await fetch(
        `${mockserver.url}/_apis/projects/Platform/teams?api-version=7.1-preview.3&$skip=0&$top=100`,
      )
      const second = await fetch(
        `${mockserver.url}/_apis/projects/Platform/teams?api-version=7.1-preview.3&$skip=100&$top=100`,
      )
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
    })
  })

  it('GET teams failure statuses', async () => {
    const statuses = [401, 403, 404, 429]
    for (const status of statuses) {
      const provider = await adoProvider(`ado-teams-${status}`)
      provider.addInteraction({
        uponReceiving: `teams request returns ${status}`,
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/Platform/teams',
          query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        },
        willRespondWith: {
          status,
          headers: {'Content-Type': 'application/json'},
          body: {message: `Error ${status}`},
        },
      })

      await provider.executeTest(async (mockserver) => {
        const response = await fetch(
          `${mockserver.url}/_apis/projects/Platform/teams?api-version=7.1-preview.3&$skip=0&$top=100`,
        )
        expect(response.status).toBe(status)
      })
    }
  })

  it('GET team members success, empty, and not found', async () => {
    const provider = await adoProvider('ado-members')
    provider
      .addInteraction({
        uponReceiving: 'members request',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/p1/teams/t1/members',
          query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            count: 1,
            value: [
              {
                id: 'u1',
                displayName: 'Ada',
                uniqueName: 'ada@contoso.com',
                isContainer: false,
              },
            ],
          },
        },
      })
      .addInteraction({
        uponReceiving: 'empty members request',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/p1/teams/t2/members',
          query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {count: 0, value: []},
        },
      })
      .addInteraction({
        uponReceiving: 'missing team members request',
        withRequest: {
          method: 'GET',
          path: '/_apis/projects/p1/teams/missing/members',
          query: {'api-version': '7.1-preview.3', '$skip': '0', '$top': '100'},
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Team not found'},
        },
      })

    await provider.executeTest(async (mockserver) => {
      const success = await fetch(
        `${mockserver.url}/_apis/projects/p1/teams/t1/members?api-version=7.1-preview.3&$skip=0&$top=100`,
      )
      const empty = await fetch(
        `${mockserver.url}/_apis/projects/p1/teams/t2/members?api-version=7.1-preview.3&$skip=0&$top=100`,
      )
      const missing = await fetch(
        `${mockserver.url}/_apis/projects/p1/teams/missing/members?api-version=7.1-preview.3&$skip=0&$top=100`,
      )
      expect(success.status).toBe(200)
      expect(empty.status).toBe(200)
      expect(missing.status).toBe(404)
    })
  })

  it('GET identity success and not found', async () => {
    const provider = await adoProvider('ado-identity')
    provider
      .addInteraction({
        uponReceiving: 'identity request',
        withRequest: {
          method: 'GET',
          path: '/_apis/graph/users/descriptor-1',
          query: {'api-version': '7.1-preview.1'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            originId: 'u1',
            displayName: 'Ada',
            principalName: 'ada@contoso.com',
            mailAddress: 'ada@contoso.com',
          },
        },
      })
      .addInteraction({
        uponReceiving: 'missing identity request',
        withRequest: {
          method: 'GET',
          path: '/_apis/graph/users/missing',
          query: {'api-version': '7.1-preview.1'},
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Not found'},
        },
      })

    await provider.executeTest(async (mockserver) => {
      const found = await fetch(
        `${mockserver.url}/_apis/graph/users/descriptor-1?api-version=7.1-preview.1`,
      )
      const missing = await fetch(
        `${mockserver.url}/_apis/graph/users/missing?api-version=7.1-preview.1`,
      )
      expect(found.status).toBe(200)
      expect(missing.status).toBe(404)
    })
  })
})
