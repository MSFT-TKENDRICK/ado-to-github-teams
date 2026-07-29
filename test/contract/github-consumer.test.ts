import path from 'node:path'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import type {ResolvedCredentials} from '../../src/auth/manager.js'
import {validateGitHubCredential} from '../../src/auth/validate.js'
import {makeGitHubLayer} from '../../src/effect/layers.js'
import {GitHubServiceTag, type GitHubServiceFx} from '../../src/effect/services.js'

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe.sequential : describe.skip
const credentialAuthorization = 'Bearer contract-token'
const serviceAuthorization = 'token contract-token'
const credentials: ResolvedCredentials = {
  adoPat: 'unused',
  adoTokenType: 'pat',
  githubPat: 'contract-token',
  entraClientId: 'unused',
  entraClientSecret: 'unused',
  entraClientTenantId: 'unused',
}
const findUserQuery = `
          query FindUsersByEmail($query: String!) {
            search(query: $query, type: USER, first: 10) {
              nodes {
                __typename
                ... on User {
                  login
                }
              }
            }
          }
        `

async function githubProvider() {
  const {MatchersV3, PactV3} = await import('@pact-foundation/pact')
  return {
    matchers: MatchersV3,
    provider: new PactV3({
      consumer: 'ado-to-github-teams',
      provider: 'github-api',
      dir: path.resolve('test/contract/pacts'),
    }),
  }
}

function runGitHub<A>(
  providerUrl: string,
  use: (service: GitHubServiceFx) => Effect.Effect<A, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* GitHubServiceTag
      return yield* use(service)
    }).pipe(Effect.provide(makeGitHubLayer(credentials, 'contoso', providerUrl))),
  )
}

contractDescribe('GitHub consumer contracts', () => {
  it('validates a token with the production credential request', async () => {
    const {matchers, provider} = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub credential validation request',
      withRequest: {
        method: 'GET',
        path: '/user',
        headers: {Authorization: credentialAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {id: matchers.integer(1), login: matchers.string('migration-bot')},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        validateGitHubCredential('contract-token', mockserver.url),
      ).resolves.toBeUndefined()
    })
  })

  it('loads and maps a team by slug', async () => {
    const {matchers, provider} = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub team lookup',
      withRequest: {
        method: 'GET',
        path: '/orgs/contoso/teams/core',
        headers: {Authorization: serviceAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          id: matchers.integer(1),
          slug: matchers.string('core'),
          name: matchers.string('Core'),
          description: matchers.string('Core engineering'),
          privacy: matchers.regex('^(closed|secret)$', 'closed'),
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => service.getTeamBySlug('core')),
      ).resolves.toEqual({
        id: 1,
        slug: 'core',
        name: 'Core',
        description: 'Core engineering',
        privacy: 'closed',
      })
    })
  })

  it('creates a missing team after the idempotency lookup', async () => {
    const {matchers, provider} = await githubProvider()
    provider
      .addInteraction({
        uponReceiving: 'a missing GitHub team lookup before creation',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams/core',
          headers: {Authorization: serviceAuthorization},
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: matchers.string('Not Found')},
        },
      })
      .addInteraction({
        uponReceiving: 'a GitHub team creation request',
        withRequest: {
          method: 'POST',
          path: '/orgs/contoso/teams',
          headers: {
            Authorization: serviceAuthorization,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: {
            name: 'Core',
            description: 'Core engineering',
            privacy: 'closed',
          },
        },
        willRespondWith: {
          status: 201,
          headers: {'Content-Type': 'application/json'},
          body: {
            id: matchers.integer(2),
            slug: matchers.string('core'),
            name: matchers.string('Core'),
            description: matchers.string('Core engineering'),
            privacy: matchers.regex('^(closed|secret)$', 'closed'),
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) =>
          service.createTeam({
            slug: 'core',
            name: 'Core',
            description: 'Core engineering',
            privacy: 'closed',
          }),
        ),
      ).resolves.toMatchObject({id: 2, slug: 'core', name: 'Core'})
    })
  })

  it('checks membership before assigning a user to a team', async () => {
    const {matchers, provider} = await githubProvider()
    provider
      .addInteraction({
        uponReceiving: 'a missing GitHub team membership lookup',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams/core/memberships/ada',
          headers: {Authorization: serviceAuthorization},
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: matchers.string('Not Found')},
        },
      })
      .addInteraction({
        uponReceiving: 'a GitHub team membership assignment',
        withRequest: {
          method: 'PUT',
          path: '/orgs/contoso/teams/core/memberships/ada',
          headers: {
            Authorization: serviceAuthorization,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: {role: 'member'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {
            state: matchers.string('active'),
            role: matchers.string('member'),
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => service.addTeamMember('core', 'ada')),
      ).resolves.toBeUndefined()
    })
  })

  it('searches for a managed user through the production GraphQL request', async () => {
    const {matchers, provider} = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub GraphQL user search',
      withRequest: {
        method: 'POST',
        path: '/graphql',
        headers: {
          Authorization: serviceAuthorization,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: {
          query: findUserQuery,
          variables: {query: 'ada@contoso.com in:email org:contoso'},
        },
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          data: {
            search: {
              nodes: matchers.atLeastLike(
                {
                  __typename: 'User',
                  login: matchers.string('ada'),
                },
                0,
                1,
              ),
            },
          },
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => service.findUserByEmail('ada@contoso.com')),
      ).resolves.toEqual({
        login: 'ada',
        email: 'ada@contoso.com',
        type: 'User',
      })
    })
  })

  it('checks whether a GitHub user is suspended', async () => {
    const {matchers, provider} = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub user lookup for suspension state',
      withRequest: {
        method: 'GET',
        path: '/users/suspended-user',
        headers: {Authorization: serviceAuthorization},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          id: matchers.integer(3),
          login: matchers.string('suspended-user'),
          suspended_at: matchers.regex(
            '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$',
            '2026-07-01T00:00:00Z',
          ),
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => service.isUserSuspended('suspended-user')),
      ).resolves.toBe(true)
    })
  })

  it('preserves the SSO challenge when GitHub denies access', async () => {
    const {matchers, provider} = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub team lookup blocked by SSO',
      withRequest: {
        method: 'GET',
        path: '/orgs/contoso/teams/core',
        headers: {Authorization: serviceAuthorization},
      },
      willRespondWith: {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-github-sso': 'required; url=https://github.com/orgs/contoso/sso',
        },
        body: {message: matchers.string('SSO required')},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => service.getTeamBySlug('core')),
      ).rejects.toMatchObject({
        _tag: 'PermissionFailure',
        status: 403,
        ssoRequired: true,
      })
    })
  })
})
