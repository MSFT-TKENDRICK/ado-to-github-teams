import type {TokenCredential} from '@azure/identity'
import {ADO_SCOPE, type AdoCredential} from './manager.js'
import {HttpStatusError} from '../utils/errors.js'

function checkResponse(response: Response, context: string): void {
  if (!response.ok) {
    throw new HttpStatusError(`${context} failed with HTTP ${response.status}`, response.status, {
      'retry-after': response.headers.get('retry-after') ?? undefined,
      'x-github-sso': response.headers.get('x-github-sso') ?? undefined,
    })
  }
}

export async function resolveAdoToken(credential: AdoCredential): Promise<string> {
  if (credential.kind === 'pat') {
    return credential.token
  }

  const accessToken = await credential.credential.getToken(ADO_SCOPE)
  if (!accessToken?.token) {
    throw new Error('Unable to acquire an Azure DevOps token from the ambient Azure identity.')
  }
  return accessToken.token
}

export async function validateAdoCredential(
  credential: AdoCredential,
  orgUrl: string,
): Promise<void> {
  const token = await resolveAdoToken(credential)
  const normalizedOrg = orgUrl.replace(/\/+$/, '')
  const response = await fetch(
    `${normalizedOrg}/_apis/connectionData?connectOptions=none&lastChangeId=-1&lastChangeId64=-1`,
    {
      headers:
        credential.kind === 'entra'
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
  credential: TokenCredential,
  scopes: readonly string[],
): Promise<void> {
  const token = await credential.getToken([...scopes])
  if (!token?.token) {
    throw new Error('Unable to acquire token for Entra validation.')
  }
}
