const sensitivePatterns: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:password|secret|token|authorization)\s*[:=]\s*[^\s,;]+/gi,
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
