const sensitivePatterns: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:password|secret|token|authorization)\s*[:=]\s*[^\s,;]+/gi,
  // Targeted (non-blanket) tenant-identifier patterns: these mask Entra tenant GUIDs embedded in
  // free text without touching unrelated, useful diagnostic GUIDs (e.g. Azure x-ms-request-id).
  /\btenantId\s*[:=]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\blogin\.microsoftonline\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
]

export function redactSensitiveText(value: string): string {
  return sensitivePatterns.reduce(
    (current, pattern) => current.replace(pattern, '[REDACTED]'),
    value,
  )
}

export function maskUserPrincipalName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const [local, domain] = value.split('@')
  if (!domain) {
    return '[REDACTED]'
  }
  return `${local?.slice(0, 1) ?? ''}***@${domain}`
}

const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Masks a tenant/object/client identifier by default. Preserves the leading 8 hex characters
 * (enough to correlate against Azure/Entra logs referencing the same identifier) and replaces
 * the remainder so the full GUID is never disclosed in an escalation dossier.
 */
export function maskGuid(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  if (!guidPattern.test(value)) {
    return value.length <= 4 ? '[REDACTED]' : `${value.slice(0, 4)}\u2026[REDACTED]`
  }
  return `${value.slice(0, 8)}-****-****-****-************`
}

function maskSlug(value: string): string {
  if (value.length === 0) {
    return value
  }
  if (value.length <= 2) {
    return '*'.repeat(value.length)
  }
  return `${value.slice(0, 1)}${'*'.repeat(value.length - 2)}${value.slice(-1)}`
}

/**
 * Masks an organization/project/config identifier (ADO org URL, ADO project, GitHub org, team
 * prefix/suffix) by default. URL-aware: preserves the scheme and host (e.g. `dev.azure.com`) so
 * the platform is still identifiable, but masks the org/project path segment(s). Falls back to
 * plain slug masking for non-URL identifiers.
 */
export function maskOrganizationIdentifier(value: string): string {
  if (!value) {
    return value
  }
  try {
    const url = new URL(value)
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
    if (segments.length === 0) {
      return url.origin
    }
    return `${url.origin}/${segments.map(maskSlug).join('/')}`
  } catch {
    return maskSlug(value)
  }
}
