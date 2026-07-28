import {ClientSecretCredential, DeviceCodeCredential} from '@azure/identity'
import {AuthManager} from './manager.js'

async function checkResponse(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}`)
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
  await checkResponse(response, 'Azure DevOps credential validation')
}

export async function validateGitHubCredential(token: string): Promise<void> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ado-to-github-teams',
    },
  })
  await checkResponse(response, 'GitHub credential validation')
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

  const token = await credential.getToken('https://graph.microsoft.com/.default')
  if (!token?.token) {
    throw new Error('Unable to acquire token for Entra validation.')
  }
}
