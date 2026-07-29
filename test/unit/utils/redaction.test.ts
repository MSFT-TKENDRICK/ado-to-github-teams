import {describe, expect, it} from 'vitest'
import {
  maskGuid,
  maskOrganizationIdentifier,
  maskUserPrincipalName,
  redactSensitiveText,
} from '../../../src/utils/redaction.js'

describe('maskGuid', () => {
  it('preserves the first 8 hex characters of a GUID and masks the rest', () => {
    expect(maskGuid('11111111-2222-4333-8444-555555555555')).toBe(
      '11111111-****-****-****-************',
    )
  })

  it('returns undefined for an undefined/empty value', () => {
    expect(maskGuid(undefined)).toBeUndefined()
    expect(maskGuid('')).toBeUndefined()
  })

  it('falls back to a partial-prefix redaction for non-GUID-shaped values', () => {
    expect(maskGuid('not-a-guid')).toBe('not-\u2026[REDACTED]')
    expect(maskGuid('ab')).toBe('[REDACTED]')
  })
})

describe('maskOrganizationIdentifier', () => {
  it('preserves the URL scheme/host and masks only the path segments', () => {
    expect(maskOrganizationIdentifier('https://dev.azure.com/contoso')).toBe(
      'https://dev.azure.com/c*****o',
    )
  })

  it('masks a plain slug (non-URL) identifier', () => {
    expect(maskOrganizationIdentifier('Platform')).toBe('P******m')
    expect(maskOrganizationIdentifier('contoso')).toBe('c*****o')
  })

  it('passes through an empty string unchanged', () => {
    expect(maskOrganizationIdentifier('')).toBe('')
  })

  it('masks very short slugs completely', () => {
    expect(maskOrganizationIdentifier('ab')).toBe('**')
  })
})

describe('maskUserPrincipalName', () => {
  it('keeps the first character of the local part and the full domain', () => {
    expect(maskUserPrincipalName('operator@contoso.com')).toBe('o***@contoso.com')
  })

  it('returns undefined for an undefined value', () => {
    expect(maskUserPrincipalName(undefined)).toBeUndefined()
  })

  it('fully redacts a value with no domain', () => {
    expect(maskUserPrincipalName('not-an-upn')).toBe('[REDACTED]')
  })
})

describe('redactSensitiveText', () => {
  it('redacts bearer tokens and key=value secrets', () => {
    // The Bearer-value pattern redacts first, then the authorization:-prefix pattern also
    // matches what remains ("Authorization: [REDACTED]"), collapsing to a single marker.
    expect(redactSensitiveText('Authorization: Bearer abc.def-ghi')).toBe('[REDACTED]')
    expect(redactSensitiveText('token=super-secret-value')).toBe('[REDACTED]')
  })

  it('redacts a tenant ID embedded in free text (tenantId=<guid> form)', () => {
    expect(
      redactSensitiveText('Failed to authenticate: tenantId=11111111-2222-4333-8444-555555555555'),
    ).toBe('Failed to authenticate: [REDACTED]')
  })

  it('redacts a tenant ID embedded in a login.microsoftonline.com URL', () => {
    expect(
      redactSensitiveText(
        'See https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/oauth2/token',
      ),
    ).toBe('See https://[REDACTED]/oauth2/token')
  })

  it('does not touch unrelated diagnostic GUIDs (e.g. an x-ms-request-id)', () => {
    const text = 'x-ms-request-id: 99999999-8888-4777-8666-555555555555'
    expect(redactSensitiveText(text)).toBe(text)
  })
})
