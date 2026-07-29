import path from 'node:path'
import {Cause, Effect, Exit, Option} from 'effect'
import {describe, expect, it} from 'vitest'
import type {PactV3 as PactV3Class} from '@pact-foundation/pact'
import type {TokenCredential} from '@azure/identity'
import type {ResolvedCredentials} from '../../src/auth/manager.js'
import {validateGitHubCredential} from '../../src/auth/validate.js'
import {makeGitHubLayer} from '../../src/effect/layers.js'
import {GitHubServiceTag, type GitHubServiceFx} from '../../src/effect/services.js'

/**
 * Consumer-side boundary-shape checks, NOT GitHub provider verification.
 *
 * These specs run the production GitHub adapter (REST and GraphQL) against
 * a Pact mock server to catch accidental drift in the requests we send and
 * the responses we parse. We do not own the GitHub API, so it cannot be
 * provider-verified from this repository. A green run here proves our
 * adapter matches the shape it was written against; it is NOT evidence of
 * live compatibility with github.com/GHEC and these pacts must never be
 * published to a broker or cited as `can-i-deploy` evidence for GitHub.
 *
 * Validate real drift with a controlled, human-reviewed run against a
 * non-production GitHub organization whenever the adapter or the targeted
 * REST/GraphQL surface changes (see "Third-party contract coverage" in
 * README.md).
 */

type PactV3Type = typeof PactV3Class

const pactSupported = !(process.platform === 'win32' && process.arch === 'arm64')
const contractDescribe = pactSupported ? describe.sequential : describe.skip
const ambientCredential: TokenCredential = {
  getToken: async () => ({token: 'unused', expiresOnTimestamp: Date.now() + 60_000}),
}
const credentials: ResolvedCredentials = {
  ado: {kind: 'entra', credential: ambientCredential, source: 'ambient'},
  githubToken: 'contract-token',
  githubSource: 'environment',
  entraCredential: ambientCredential,
  entraScopes: ['https://graph.microsoft.com/.default'],
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

async function githubProvider(): Promise<InstanceType<PactV3Type>> {
  const {PactV3} = await import('@pact-foundation/pact')
  return new PactV3({
    consumer: 'ado-to-github-teams',
    provider: 'github-api',
    dir: path.resolve('test/contract/pacts'),
  })
}

function runGitHub<A>(
  providerUrl: string,
  use: (service: GitHubServiceFx) => Effect.Effect<A, unknown>,
): Promise<A> {
  // `Effect.runPromise` rejects with an opaque `FiberFailure` wrapper on a
  // typed failure, not the domain error itself, so `.rejects.toMatchObject`
  // assertions below would never see `_tag`/`status`/`ssoRequired`. Run to
  // an `Exit` and re-throw the actual failure value so the Promise-based
  // assertions see the real, tagged domain error.
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* GitHubServiceTag
      return yield* use(service)
    }).pipe(Effect.provide(makeGitHubLayer(credentials, 'contoso', providerUrl))),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value
    }
    const failure = Cause.failureOption(exit.cause)
    throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)
  })
}

contractDescribe('GitHub consumer boundary-shape checks (not provider-verified)', () => {
  it('validates a token with the production credential request', async () => {
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub credential validation request',
      withRequest: {
        method: 'GET',
        path: '/user',
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {id: 1, login: 'migration-bot'},
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        validateGitHubCredential('contract-token', mockserver.url),
      ).resolves.toBeUndefined()
    })
  })

  it('loads and maps a team by slug', async () => {
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub team lookup',
      withRequest: {
        method: 'GET',
        path: '/orgs/contoso/teams/core',
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          id: 1,
          slug: 'core',
          name: 'Core',
          description: 'Core engineering',
          privacy: 'closed',
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
    const provider = await githubProvider()
    provider
      .addInteraction({
        uponReceiving: 'a missing GitHub team lookup before creation',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams/core',
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Not Found'},
        },
      })
      .addInteraction({
        uponReceiving: 'a GitHub team creation request',
        withRequest: {
          method: 'POST',
          path: '/orgs/contoso/teams',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
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
            id: 2,
            slug: 'core',
            name: 'Core',
            description: 'Core engineering',
            privacy: 'closed',
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

  it('creates a nested team with an explicit parent id', async () => {
    const provider = await githubProvider()
    provider
      .addInteraction({
        uponReceiving: 'a missing nested GitHub team lookup before creation',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams/platform',
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Not Found'},
        },
      })
      .addInteraction({
        uponReceiving: 'a nested GitHub team creation request',
        withRequest: {
          method: 'POST',
          path: '/orgs/contoso/teams',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: {
            name: 'Platform',
            description: '',
            privacy: 'closed',
            parent_team_id: 7,
          },
        },
        willRespondWith: {
          status: 201,
          headers: {'Content-Type': 'application/json'},
          body: {
            id: 8,
            slug: 'platform',
            name: 'Platform',
            description: null,
            privacy: 'closed',
            parent: {id: 7, slug: 'engineering'},
          },
        },
      })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) =>
          service.createTeam({
            slug: 'platform',
            name: 'Platform',
            privacy: 'closed',
            parentTeamId: 7,
          }),
        ),
      ).resolves.toMatchObject({
        id: 8,
        slug: 'platform',
        parentTeam: {id: 7, slug: 'engineering'},
      })
    })
  })

  it('assigns an explicit repository role to a leaf team', async () => {
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub leaf team repository permission update',
      withRequest: {
        method: 'PUT',
        path: '/orgs/contoso/teams/api-contributors/repos/contoso/api',
        headers: {'Content-Type': 'application/json; charset=utf-8'},
        body: {permission: 'push'},
      },
      willRespondWith: {
        status: 204,
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => {
          const setPermission = service.setTeamRepositoryPermission
          if (!setPermission) {
            throw new Error('Repository permission operation is unavailable')
          }
          return setPermission('api-contributors', 'contoso/api', 'write')
        }),
      ).resolves.toBeUndefined()
    })
  })

  it('reads the current repository role with the repository response media type', async () => {
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub leaf team repository permission lookup',
      withRequest: {
        method: 'GET',
        path: '/orgs/contoso/teams/api-contributors/repos/contoso/api',
        headers: {Accept: 'application/vnd.github.v3.repository+json'},
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          full_name: 'contoso/api',
          role_name: 'admin',
          permissions: {pull: true, triage: true, push: true, maintain: true, admin: true},
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => {
          const getPermission = service.getTeamRepositoryPermission
          if (!getPermission) {
            throw new Error('Repository permission lookup is unavailable')
          }
          return getPermission('api-contributors', 'contoso/api')
        }),
      ).resolves.toBe('admin')
    })
  })

  it('detects an Enterprise Managed Users external group connection', async () => {
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub external group lookup for a team',
      withRequest: {
        method: 'GET',
        path: '/orgs/contoso/teams/api-contributors/external-groups',
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          groups: [{group_id: 9, group_name: 'API Contributors', updated_at: '2026-01-01'}],
        },
      },
    })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => {
          const isManaged = service.isTeamIdpManaged
          if (!isManaged) {
            throw new Error('Identity-provider lookup is unavailable')
          }
          return isManaged('api-contributors')
        }),
      ).resolves.toBe(true)
    })
  })

  it('falls back to team synchronization outside Enterprise Managed Users', async () => {
    const provider = await githubProvider()
    provider
      .addInteraction({
        uponReceiving: 'an unavailable GitHub external group lookup',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams/api-contributors/external-groups',
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Not Found'},
        },
      })
      .addInteraction({
        uponReceiving: 'a GitHub team synchronization lookup',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams/api-contributors/team-sync/group-mappings',
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {groups: []},
        },
      })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => {
          const isManaged = service.isTeamIdpManaged
          if (!isManaged) {
            throw new Error('Identity-provider lookup is unavailable')
          }
          return isManaged('api-contributors')
        }),
      ).resolves.toBe(false)
    })
  })

  it('checks membership before assigning a user to a team', async () => {
    const provider = await githubProvider()
    provider
      .addInteraction({
        uponReceiving: 'a missing GitHub team membership lookup',
        withRequest: {
          method: 'GET',
          path: '/orgs/contoso/teams/core/memberships/ada',
        },
        willRespondWith: {
          status: 404,
          headers: {'Content-Type': 'application/json'},
          body: {message: 'Not Found'},
        },
      })
      .addInteraction({
        uponReceiving: 'a GitHub team membership assignment',
        withRequest: {
          method: 'PUT',
          path: '/orgs/contoso/teams/core/memberships/ada',
          headers: {'Content-Type': 'application/json; charset=utf-8'},
          body: {role: 'member'},
        },
        willRespondWith: {
          status: 200,
          headers: {'Content-Type': 'application/json'},
          body: {state: 'active', role: 'member'},
        },
      })

    await provider.executeTest(async (mockserver) => {
      await expect(
        runGitHub(mockserver.url, (service) => service.addTeamMember('core', 'ada')),
      ).resolves.toBeUndefined()
    })
  })

  it('searches for a managed user through the production GraphQL request', async () => {
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub GraphQL user search',
      withRequest: {
        method: 'POST',
        path: '/graphql',
        headers: {'Content-Type': 'application/json; charset=utf-8'},
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
              nodes: [{__typename: 'User', login: 'ada'}],
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
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub user lookup for suspension state',
      withRequest: {
        method: 'GET',
        path: '/users/suspended-user',
      },
      willRespondWith: {
        status: 200,
        headers: {'Content-Type': 'application/json'},
        body: {
          id: 3,
          login: 'suspended-user',
          suspended_at: '2026-07-01T00:00:00Z',
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
    const provider = await githubProvider()
    provider.addInteraction({
      uponReceiving: 'a GitHub team lookup blocked by SSO',
      withRequest: {
        method: 'GET',
        path: '/orgs/contoso/teams/core',
      },
      willRespondWith: {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-github-sso': 'required; url=https://github.com/orgs/contoso/sso',
        },
        body: {message: 'SSO required'},
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
