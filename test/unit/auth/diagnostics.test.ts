import type {TokenCredential} from '@azure/identity'
import {Effect, Layer} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {
  credentialResolutionDiagnostics,
  decodeAuthDiagnosticResult,
  renderAuthDiagnostics,
  renderAuthDiagnosticsJson,
  runAuthDiagnostics,
} from '../../../src/auth/diagnostics.js'
import type {ResolvedCredentials} from '../../../src/auth/manager.js'
import {CredentialResolutionFailure, ValidationFailure} from '../../../src/effect/errors.js'
import {AuthValidationServiceTag} from '../../../src/effect/services.js'

const entraCredential: TokenCredential = {
  getToken: async () => ({token: 'entra-secret', expiresOnTimestamp: Date.now() + 60_000}),
}

function credentials(): ResolvedCredentials {
  return {
    ado: {kind: 'pat', token: 'ado-secret', source: 'environment'},
    githubToken: 'github-secret',
    githubSource: 'github-cli',
    entraCredential,
    entraScopes: ['https://graph.microsoft.com/.default'],
  }
}

function validationLayer(validators: {
  readonly ado: (credential: ResolvedCredentials['ado'], adoOrg: string) => Promise<void>
  readonly github: (token: string) => Promise<void>
  readonly entra: (
    credential: ResolvedCredentials['entraCredential'],
    scopes: ResolvedCredentials['entraScopes'],
  ) => Promise<void>
}) {
  return Layer.succeed(AuthValidationServiceTag, {
    validateAdo: (credential, adoOrg) =>
      Effect.tryPromise({
        try: async () => validators.ado(credential, adoOrg),
        catch: (error) => new ValidationFailure({service: 'ado', message: String(error)}),
      }),
    validateGitHub: (token) =>
      Effect.tryPromise({
        try: async () => validators.github(token),
        catch: (error) => new ValidationFailure({service: 'github', message: String(error)}),
      }),
    validateEntra: (credential, scopes) =>
      Effect.tryPromise({
        try: async () => validators.entra(credential, scopes),
        catch: (error) => new ValidationFailure({service: 'entra', message: String(error)}),
      }),
  })
}

describe('authentication diagnostics', () => {
  it('makes planned, attempted, skipped, source, and remediation semantics explicit', async () => {
    const ado = vi.fn(async () => undefined)
    const github = vi.fn(async () => undefined)
    const entra = vi.fn(async () => undefined)

    const result = await Effect.runPromise(
      runAuthDiagnostics(credentials(), undefined).pipe(
        Effect.provide(validationLayer({ado, github, entra})),
      ),
    )

    expect(result).toEqual({
      schemaVersion: 1,
      status: 'passed',
      providers: [
        expect.objectContaining({
          provider: 'azure-devops',
          status: 'skipped',
          planned: false,
          attempted: false,
          source: 'environment',
          remediation: expect.stringContaining('--ado-org'),
        }),
        expect.objectContaining({
          provider: 'github',
          status: 'passed',
          planned: true,
          attempted: true,
          source: 'github-cli',
        }),
        expect.objectContaining({
          provider: 'entra',
          status: 'passed',
          planned: true,
          attempted: true,
          source: 'ambient-azure-identity',
        }),
      ],
    })
    expect(ado).not.toHaveBeenCalled()
    expect(github).toHaveBeenCalledWith('github-secret')
    expect(entra).toHaveBeenCalledWith(entraCredential, ['https://graph.microsoft.com/.default'])
  })

  it('renders actionable human diagnostics without credential values', async () => {
    const result = await Effect.runPromise(
      runAuthDiagnostics(credentials(), 'https://dev.azure.com/contoso').pipe(
        Effect.provide(
          validationLayer({
            ado: async () => undefined,
            github: async () => undefined,
            entra: async () => undefined,
          }),
        ),
      ),
    )

    const rendered = renderAuthDiagnostics(result)

    expect(rendered).toContain('Credential diagnostics: PASSED')
    expect(rendered).toContain('Azure DevOps: PASSED')
    expect(rendered).toContain('Credential source: environment')
    expect(rendered).toContain('Next step: No action required.')
    expect(rendered).not.toContain('ado-secret')
    expect(rendered).not.toContain('github-secret')
    expect(rendered).not.toContain('entra-secret')
    expect(rendered).not.toContain('contoso')
  })

  it('emits exact schema-backed failure JSON and redacts provider error details', async () => {
    const result = await Effect.runPromise(
      runAuthDiagnostics(credentials(), 'https://dev.azure.com/contoso').pipe(
        Effect.provide(
          validationLayer({
            ado: async () => {
              throw new Error('rejected ado-secret for tenant confidential-tenant')
            },
            github: async () => undefined,
            entra: async () => undefined,
          }),
        ),
      ),
    )
    const json = renderAuthDiagnosticsJson(result)
    const decoded = await Effect.runPromise(decodeAuthDiagnosticResult(JSON.parse(json)))

    expect(decoded.status).toBe('failed')
    expect(decoded.providers[0]).toMatchObject({
      provider: 'azure-devops',
      status: 'failed',
      planned: true,
      attempted: true,
      reason: 'Credential validation did not complete successfully.',
    })
    expect(json).not.toContain('ado-secret')
    expect(json).not.toContain('github-secret')
    expect(json).not.toContain('entra-secret')
    expect(json).not.toContain('confidential-tenant')
    expect(json).not.toContain('contoso')
  })

  it('renders credential resolution failures through the same redacted provider contract', async () => {
    const failure = new CredentialResolutionFailure({
      service: 'auth',
      provider: 'github',
      message: 'github-secret failed for confidential-tenant',
      cause: new Error('ado-secret and entra-secret'),
    })

    const result = await Effect.runPromise(credentialResolutionDiagnostics(failure, undefined))
    const json = renderAuthDiagnosticsJson(result)

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: 'failed',
      providers: [
        {
          provider: 'azure-devops',
          status: 'skipped',
          planned: false,
          attempted: false,
          source: 'unavailable',
          remediation: expect.stringContaining('--ado-org'),
        },
        {provider: 'github', status: 'failed', attempted: false, source: 'unavailable'},
        {provider: 'entra', status: 'skipped', attempted: false, source: 'unavailable'},
      ],
    })
    expect(json).not.toContain('github-secret')
    expect(json).not.toContain('ado-secret')
    expect(json).not.toContain('entra-secret')
    expect(json).not.toContain('confidential-tenant')
  })

  it('rejects malformed diagnostics', async () => {
    await expect(
      Effect.runPromise(
        decodeAuthDiagnosticResult({
          schemaVersion: 1,
          status: 'passed',
          providers: [],
          secret: 'must-not-pass',
        }),
      ),
    ).rejects.toThrow('Malformed authentication diagnostic result')
  })
})
