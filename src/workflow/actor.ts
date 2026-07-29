import type {EntraActorDescription} from '../types/index.js'

function value(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  return keys.map((key) => env[key]?.trim()).find(Boolean)
}

export function describeEntraActor(
  env: NodeJS.ProcessEnv = process.env,
): EntraActorDescription {
  const tenantId = value(env, 'AZURE_TENANT_ID', 'ENTRA_TENANT_ID')
  const clientId = value(env, 'AZURE_CLIENT_ID', 'ENTRA_CLIENT_ID')
  const displayName =
    value(env, 'ENTRA_USER_DESCRIPTION', 'USER', 'USERNAME') ??
    'Entra identity used by the migration worker'

  let kind: EntraActorDescription['kind'] = 'delegated-user'
  if (value(env, 'AZURE_FEDERATED_TOKEN_FILE')) {
    kind = 'workload-identity'
  } else if (value(env, 'IDENTITY_ENDPOINT', 'MSI_ENDPOINT')) {
    kind = 'managed-identity'
  } else if (
    value(
      env,
      'AZURE_CLIENT_SECRET',
      'ENTRA_CLIENT_SECRET',
      'AZURE_CLIENT_CERTIFICATE_PATH',
    )
  ) {
    kind = 'service-principal'
  }

  return {
    kind,
    displayName,
    ...(tenantId ? {tenantId} : {}),
    ...(clientId ? {clientId} : {}),
  }
}
