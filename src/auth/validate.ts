import {ClientSecretCredential, DeviceCodeCredential} from '@azure/identity'
import {AuthManager, ENTRA_DELEGATED_SCOPES} from './manager.js'
import {HttpStatusError} from '../utils/errors.js'

function checkResponse(response: Response, context: string): void {
  if (!response.ok) {
    throw new HttpStatusError(
      `${context} failed with HTTP ${response.status}`,
      response.status,
      {
        'retry-after': response.headers.get('retry-after') ?? undefined,
        'x-github-sso': response.headers.get('x-github-sso') ?? undefined,
      },
    )
  }
}

export async function validateAdoCredential(token: string, orgUrl: string): Promise<void> {
  const normalizedOrg = orgUrl.replace(/\/+$/, '')
  const isJwt = token.split('.').length === 3
  const response = await fetch(
    `${normalizedOrg}/_apis/connectionData?connectOptions=none&lastChangeId=-1&lastChangeId64=-1`,
    {
      headers: isJwt
        ? {Authorization: `Bearer ${token}`}
        : {Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`},
    },
  )
  checkResponse(response, 'Azure DevOps credential validation')
}

export async function validateGitHubCredential(
  token: string,
  apiBaseUrl = 'https://api.github.com',
): Promise<void> {
  const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ado-to-github-teams',
    },
  })
  checkResponse(response, 'GitHub credential validation')
}

export async function validateEntraCredential(
  clientId: string,
  clientSecret: string,
  tenantId: string,
): Promise<void> {
  if (AuthManager.isDeviceFlowSecret(clientSecret)) {
    return
  }

  const credential =
    clientSecret.trim().length === 0
      ? new DeviceCodeCredential({
          clientId,
          tenantId,
          userPromptCallback: (deviceCodeInfo) => {
            console.log(deviceCodeInfo.message)
          },
        })
      : new ClientSecretCredential(tenantId, clientId, clientSecret)

  const scopes =
    credential instanceof DeviceCodeCredential
      ? [...ENTRA_DELEGATED_SCOPES]
      : ['https://graph.microsoft.com/.default']
  const token = await credential.getToken(scopes)
  if (!token?.token) {
    throw new Error('Unable to acquire token for Entra validation.')
  }
}
