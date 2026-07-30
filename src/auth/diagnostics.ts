import {Effect, Either, Schema} from 'effect'
import {DecodeFailure, type DomainFailure} from '../effect/errors.js'
import {AuthValidationServiceTag} from '../effect/services.js'
import type {ResolvedCredentials} from './manager.js'

export const AuthDiagnosticProviderSchema = Schema.Literal('azure-devops', 'github', 'entra')
export const AuthDiagnosticStatusSchema = Schema.Literal('passed', 'skipped', 'failed')
export const AuthCredentialSourceSchema = Schema.Literal(
  'environment',
  'ambient-azure-identity',
  'github-cli',
  'device-code',
  'unavailable',
)

export const AuthProviderDiagnosticSchema = Schema.Struct({
  provider: AuthDiagnosticProviderSchema,
  status: AuthDiagnosticStatusSchema,
  planned: Schema.Boolean,
  attempted: Schema.Boolean,
  check: Schema.String,
  source: AuthCredentialSourceSchema,
  reason: Schema.String,
  remediation: Schema.String,
})

export const AuthDiagnosticResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal('passed', 'failed'),
  providers: Schema.Array(AuthProviderDiagnosticSchema),
})

export type AuthDiagnosticProvider = Schema.Schema.Type<typeof AuthDiagnosticProviderSchema>
export type AuthProviderDiagnostic = Schema.Schema.Type<typeof AuthProviderDiagnosticSchema>
export type AuthDiagnosticResult = Schema.Schema.Type<typeof AuthDiagnosticResultSchema>

const PROVIDER_LABELS: Readonly<Record<AuthDiagnosticProvider, string>> = {
  'azure-devops': 'Azure DevOps',
  github: 'GitHub',
  entra: 'Microsoft Entra',
}

const CHECKS: Readonly<Record<AuthDiagnosticProvider, string>> = {
  'azure-devops': 'Authenticate and verify access to the requested Azure DevOps organization.',
  github: 'Authenticate and verify that GitHub can return the current user.',
  entra: 'Acquire a Microsoft Graph token for the required migration scopes.',
}

const REMEDIATIONS: Readonly<Record<AuthDiagnosticProvider, string>> = {
  'azure-devops':
    'Sign in with an Azure developer tool or set ADO_PAT, then retry with --ado-org https://dev.azure.com/<organization>.',
  github: 'Set GH_TOKEN or GITHUB_TOKEN, or run gh auth login, then retry.',
  entra:
    'Sign in with az login, Connect-AzAccount, or azd auth login, or configure a workload identity with the required Microsoft Graph permissions.',
}

function failureReason(failure: DomainFailure): string {
  switch (failure._tag) {
    case 'AuthenticationFailure':
      return 'The provider rejected the credential.'
    case 'PermissionFailure':
      return failure.ssoRequired
        ? 'The credential requires organization SSO authorization.'
        : 'The credential does not have the required access.'
    case 'NotFoundFailure':
      return 'The provider endpoint or requested scope was not found.'
    case 'TransientFailure':
      return 'The provider was temporarily unavailable.'
    default:
      return 'Credential validation did not complete successfully.'
  }
}

function sourceForAdo(credentials: ResolvedCredentials): AuthProviderDiagnostic['source'] {
  return credentials.ado.source === 'environment' ? 'environment' : 'ambient-azure-identity'
}

function sourceForGitHub(credentials: ResolvedCredentials): AuthProviderDiagnostic['source'] {
  return credentials.githubSource
}

function passed(
  provider: AuthDiagnosticProvider,
  source: AuthProviderDiagnostic['source'],
): AuthProviderDiagnostic {
  return {
    provider,
    status: 'passed',
    planned: true,
    attempted: true,
    check: CHECKS[provider],
    source,
    reason: 'Credential validation succeeded.',
    remediation: 'No action required.',
  }
}

function failed(
  provider: AuthDiagnosticProvider,
  source: AuthProviderDiagnostic['source'],
  failure: DomainFailure,
): AuthProviderDiagnostic {
  return {
    provider,
    status: 'failed',
    planned: true,
    attempted: true,
    check: CHECKS[provider],
    source,
    reason: failureReason(failure),
    remediation: REMEDIATIONS[provider],
  }
}

function attempt(
  provider: AuthDiagnosticProvider,
  source: AuthProviderDiagnostic['source'],
  validation: Effect.Effect<void, DomainFailure>,
): Effect.Effect<AuthProviderDiagnostic> {
  return Effect.match(validation, {
    onFailure: (failure) => failed(provider, source, failure),
    onSuccess: () => passed(provider, source),
  })
}

export function decodeAuthDiagnosticResult(
  input: unknown,
): Effect.Effect<AuthDiagnosticResult, DecodeFailure> {
  const decoded = Schema.decodeUnknownEither(AuthDiagnosticResultSchema, {
    onExcessProperty: 'error',
  })(input)
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new DecodeFailure({
        service: 'auth',
        message: 'Malformed authentication diagnostic result',
      }),
    )
  }
  return Effect.succeed(decoded.right)
}

export function runAuthDiagnostics(
  credentials: ResolvedCredentials,
  adoOrg: string | undefined,
): Effect.Effect<AuthDiagnosticResult, DecodeFailure, AuthValidationServiceTag> {
  return Effect.gen(function* () {
    const validators = yield* AuthValidationServiceTag
    const adoSource = sourceForAdo(credentials)
    const ado = adoOrg
      ? attempt('azure-devops', adoSource, validators.validateAdo(credentials.ado, adoOrg))
      : Effect.succeed<AuthProviderDiagnostic>({
          provider: 'azure-devops',
          status: 'skipped',
          planned: false,
          attempted: false,
          check: CHECKS['azure-devops'],
          source: adoSource,
          reason: '--ado-org was not provided, so organization access was not checked.',
          remediation:
            'Re-run with --ado-org https://dev.azure.com/<organization> to validate Azure DevOps access.',
        })
    const github = attempt(
      'github',
      sourceForGitHub(credentials),
      validators.validateGitHub(credentials.githubToken),
    )
    const entra = attempt(
      'entra',
      'ambient-azure-identity',
      validators.validateEntra(credentials.entraCredential, credentials.entraScopes),
    )
    const providers = yield* Effect.all([ado, github, entra], {concurrency: 2})
    return yield* decodeAuthDiagnosticResult({
      schemaVersion: 1,
      status: providers.some((provider) => provider.status === 'failed') ? 'failed' : 'passed',
      providers,
    })
  })
}

export function credentialResolutionDiagnostics(
  failure: DomainFailure,
  adoOrg: string | undefined,
): Effect.Effect<AuthDiagnosticResult, DecodeFailure> {
  const blockedProvider =
    failure._tag === 'CredentialResolutionFailure' ? failure.provider : undefined
  const blockedLabel = blockedProvider ? PROVIDER_LABELS[blockedProvider] : 'authentication setup'
  const providers = (
    ['azure-devops', 'github', 'entra'] as const satisfies ReadonlyArray<AuthDiagnosticProvider>
  ).map((provider): AuthProviderDiagnostic => {
    if (provider === 'azure-devops' && !adoOrg) {
      return {
        provider,
        status: 'skipped',
        planned: false,
        attempted: false,
        check: CHECKS[provider],
        source: 'unavailable',
        reason: '--ado-org was not provided, so organization access was not planned.',
        remediation:
          'Re-run with --ado-org https://dev.azure.com/<organization> to validate Azure DevOps access.',
      }
    }
    const isFailure = blockedProvider === undefined || provider === blockedProvider
    return {
      provider,
      status: isFailure ? 'failed' : 'skipped',
      planned: true,
      attempted: false,
      check: CHECKS[provider],
      source: 'unavailable',
      reason: isFailure
        ? blockedProvider
          ? `No usable ${PROVIDER_LABELS[provider]} credential was resolved; provider validation was not attempted.`
          : 'Authentication configuration could not be resolved; provider validation was not attempted.'
        : `Validation did not start because credential resolution failed for ${blockedLabel}.`,
      remediation: isFailure
        ? REMEDIATIONS[provider]
        : `Resolve ${blockedLabel} first, then rerun auth to validate this provider.`,
    }
  })
  return decodeAuthDiagnosticResult({
    schemaVersion: 1,
    status: 'failed',
    providers,
  })
}

export function renderAuthDiagnostics(result: AuthDiagnosticResult): string {
  const lines = [`Credential diagnostics: ${result.status.toUpperCase()}`]
  for (const provider of result.providers) {
    lines.push(
      '',
      `${PROVIDER_LABELS[provider.provider]}: ${provider.status.toUpperCase()}`,
      `  Check: ${provider.check}`,
      `  Planned: ${provider.planned ? 'yes' : 'no'}`,
      `  Attempted: ${provider.attempted ? 'yes' : 'no'}`,
      `  Credential source: ${provider.source}`,
      `  Result: ${provider.reason}`,
      `  Next step: ${provider.remediation}`,
    )
  }
  return lines.join('\n')
}

export function renderAuthDiagnosticsJson(result: AuthDiagnosticResult): string {
  return JSON.stringify(result, null, 2)
}
