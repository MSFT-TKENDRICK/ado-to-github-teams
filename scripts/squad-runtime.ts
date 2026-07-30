import type {
  SquadPermissionRequest,
  SquadSessionHooks,
  SquadToolResultObject,
} from '@bradygaster/squad-sdk/adapter'
import {HookPipeline} from '@bradygaster/squad-sdk/hooks'
import {isAbsolute, relative, resolve} from 'node:path'
import squadConfig from '../squad.config.ts'
import {redactSensitiveText} from '../src/utils/redaction.js'

export type SquadAgentDefinition = (typeof squadConfig.agents)[number]

const COPILOT_TOOL_NAMES: Readonly<Record<string, string>> = {
  view: 'read_file',
  rg: 'grep_search',
  glob: 'file_search',
  powershell: 'shell',
}

const normalizeAgentRef = (agent: string): string => agent.replace(/^@/, '')

const explicitAgentPattern = (agentName: string): RegExp =>
  new RegExp(`(?:^|[^a-z0-9_-])@?${agentName}(?=$|[^a-z0-9_-])`, 'i')

const matchesRoutingPattern = (message: string, pattern: string): boolean => {
  const normalizedMessage = message.toLowerCase()
  return pattern
    .split('|')
    .map((candidate) => candidate.replaceAll('*', '').toLowerCase())
    .filter((candidate) => candidate.length > 0)
    .some((candidate) =>
      candidate.length <= 3
        ? new RegExp(`(?:^|[^a-z0-9])${candidate}(?=$|[^a-z0-9])`, 'i').test(normalizedMessage)
        : normalizedMessage.includes(candidate),
    )
}

export const resolveRoutedAgents = (message: string): SquadAgentDefinition[] => {
  const explicitAgents = squadConfig.agents.filter((agent) =>
    explicitAgentPattern(agent.name).test(message),
  )
  if (explicitAgents.length > 0) return explicitAgents

  const matchingRule = [...(squadConfig.routing?.rules ?? [])]
    .sort(
      (left, right) =>
        (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER),
    )
    .find((rule) => matchesRoutingPattern(message, rule.pattern))

  if (!matchingRule) return []

  const routedNames = new Set(matchingRule.agents.map(normalizeAgentRef))
  return squadConfig.agents.filter((agent) => routedNames.has(agent.name))
}

export const configuredToolsForAgent = (agentName: string): string[] => {
  const agent = squadConfig.agents.find((candidate) => candidate.name === agentName)
  if (!agent) throw new Error(`Unknown Squad agent: ${agentName}`)
  return agent.tools?.map((tool) => COPILOT_TOOL_NAMES[tool] ?? tool) ?? []
}

export const summarizePermissionRequest = (
  request: SquadPermissionRequest,
): {summary: Record<string, unknown>; containsSensitiveValue: boolean} => {
  const summary: Record<string, unknown> = {kind: request.kind}
  const sensitiveKey = /(?:password|secret|token|authorization|api[-_]?key)/i
  const scanVisited = new WeakSet<object>()
  const containsSensitiveValue = (value: unknown): boolean => {
    if (typeof value === 'string') return redactSensitiveText(value) !== value
    if (typeof value !== 'object' || value === null || scanVisited.has(value)) return false
    scanVisited.add(value)
    return Object.entries(value).some(
      ([key, child]) =>
        (sensitiveKey.test(key) && child !== undefined && child !== null) ||
        containsSensitiveValue(child),
    )
  }

  const redactVisited = new WeakSet<object>()
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redactSensitiveText(value)
    if (typeof value !== 'object' || value === null) return value
    if (redactVisited.has(value)) return '[CIRCULAR]'
    redactVisited.add(value)
    if (Array.isArray(value)) return value.map(redactValue)
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sensitiveKey.test(key) && child !== undefined && child !== null
          ? '[REDACTED]'
          : redactValue(child),
      ]),
    )
  }

  const fields = [
    'toolCallId',
    'toolName',
    'fileName',
    'fullCommandText',
    'diff',
    'newFileContents',
    'args',
    'url',
  ] as const
  for (const field of fields) {
    const value = request[field]
    if (value !== undefined) summary[field] = redactValue(value)
  }

  return {summary, containsSensitiveValue: containsSensitiveValue(request)}
}

const toArguments = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? {...value} : {value}

const WRITE_TOOLS = ['edit', 'create', 'write_file', 'create_file', 'apply_patch'] as const
const SHELL_TOOLS = ['powershell', 'bash', 'shell', 'exec'] as const

const extractWritePaths = (toolName: string, arguments_: Record<string, unknown>): string[] => {
  if (!WRITE_TOOLS.includes(toolName as (typeof WRITE_TOOLS)[number])) return []

  const paths = [arguments_.path, arguments_.file_path, arguments_.file].filter(
    (value): value is string => typeof value === 'string',
  )
  const patch = [arguments_.patch, arguments_.value].find(
    (value): value is string => typeof value === 'string',
  )
  if (toolName === 'apply_patch' && patch) {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const path = match[1]
      if (path) paths.push(path)
    }
    for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
      const path = match[1]
      if (path) paths.push(path)
    }
  }
  return paths
}

const globMatches = (path: string, pattern: string): boolean => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '___DOUBLESTAR___')
    .replaceAll('*', '[^/]*')
    .replaceAll('___DOUBLESTAR___', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${escaped}$`).test(path)
}

const isToolResult = (value: unknown): value is SquadToolResultObject => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SquadToolResultObject>
  return typeof candidate.textResultForLlm === 'string' && typeof candidate.resultType === 'string'
}

const createPipeline = (): HookPipeline => {
  const hooks = squadConfig.hooks
  return new HookPipeline({
    ...(hooks?.allowedWritePaths ? {allowedWritePaths: [...hooks.allowedWritePaths]} : {}),
    ...(hooks?.blockedCommands ? {blockedCommands: [...hooks.blockedCommands]} : {}),
    ...(hooks?.maxAskUser ? {maxAskUserPerSession: hooks.maxAskUser} : {}),
    ...(hooks?.scrubPii !== undefined ? {scrubPii: hooks.scrubPii} : {}),
    ...(hooks?.reviewerLockout !== undefined ? {reviewerLockout: hooks.reviewerLockout} : {}),
  })
}

export class SquadRuntimePolicy {
  readonly #pipelines = new Map<string, HookPipeline>()
  readonly #lockouts = new Map<string, Set<string>>()
  readonly #teamRoot: string

  constructor(teamRoot = process.cwd()) {
    this.#teamRoot = resolve(teamRoot)
  }

  #canonicalPath(path: string): string | undefined {
    const absolutePath = resolve(this.#teamRoot, path)
    const relativePath = relative(this.#teamRoot, absolutePath)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined
    const normalized = relativePath.replaceAll('\\', '/')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  #allowedWritePath(path: string): boolean {
    const canonicalPath = this.#canonicalPath(path)
    if (!canonicalPath) return false
    return (squadConfig.hooks?.allowedWritePaths ?? []).some((pattern) => {
      const normalizedPattern = pattern.replaceAll('\\', '/')
      return globMatches(
        canonicalPath,
        process.platform === 'win32' ? normalizedPattern.toLowerCase() : normalizedPattern,
      )
    })
  }

  #enforceWritePaths(
    toolName: string,
    arguments_: Record<string, unknown>,
  ): {action: 'allow'} | {action: 'block'; reason: string} {
    if (!WRITE_TOOLS.includes(toolName as (typeof WRITE_TOOLS)[number])) {
      return {action: 'allow'}
    }
    const paths = extractWritePaths(toolName, arguments_)
    if (paths.length === 0) {
      return {
        action: 'block',
        reason: `Write blocked: ${toolName} did not provide a verifiable repository-relative path.`,
      }
    }
    const disallowedPath = paths.find((path) => !this.#allowedWritePath(path))
    return disallowedPath
      ? {
          action: 'block',
          reason: `Write blocked: "${disallowedPath}" is outside the configured write paths.`,
        }
      : {action: 'allow'}
  }

  #lockoutArtifactsFor(agentName: string): string[] {
    return [...this.#lockouts]
      .filter(([, agents]) => agentName === 'squad' || agents.has(agentName))
      .map(([artifact]) => artifact)
  }

  #enforceLockout(
    agentName: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): {action: 'allow'} | {action: 'block'; reason: string} {
    const artifacts = this.#lockoutArtifactsFor(agentName)
    if (artifacts.length === 0) return {action: 'allow'}

    if (SHELL_TOOLS.includes(toolName as (typeof SHELL_TOOLS)[number])) {
      return {
        action: 'block',
        reason: `Reviewer lockout: shell execution is disabled for "${agentName}" while revisions are locked for ${artifacts.join(', ')}.`,
      }
    }

    if (!WRITE_TOOLS.includes(toolName as (typeof WRITE_TOOLS)[number])) {
      return {action: 'allow'}
    }

    const paths = extractWritePaths(toolName, arguments_)
      .map((path) => this.#canonicalPath(path))
      .filter((path): path is string => path !== undefined)

    if (paths.length === 0 || paths.some((path) => artifacts.includes(path))) {
      return {
        action: 'block',
        reason: `Reviewer lockout: "${agentName}" cannot revise ${artifacts.join(', ')}.`,
      }
    }

    return {action: 'allow'}
  }

  pipelineFor(agentName: string): HookPipeline {
    const existing = this.#pipelines.get(agentName)
    if (existing) return existing

    const pipeline = createPipeline()
    pipeline.addPreToolHook((context) =>
      this.#enforceWritePaths(context.toolName, context.arguments),
    )
    pipeline.addPreToolHook((context) =>
      this.#enforceLockout(agentName, context.toolName, context.arguments),
    )
    for (const [artifact, lockedAgents] of this.#lockouts) {
      if (lockedAgents.has(agentName)) {
        pipeline.getReviewerLockout().lockout(artifact, agentName)
      }
    }
    this.#pipelines.set(agentName, pipeline)
    return pipeline
  }

  lockout(artifact: string, agentName: string): void {
    const canonicalArtifact = this.#canonicalPath(artifact)
    if (!canonicalArtifact) {
      throw new Error(`Reviewer lockout path must remain inside the repository: ${artifact}`)
    }
    const lockedAgents = this.#lockouts.get(canonicalArtifact) ?? new Set<string>()
    lockedAgents.add(agentName)
    this.#lockouts.set(canonicalArtifact, lockedAgents)
    this.pipelineFor(agentName).getReviewerLockout().lockout(canonicalArtifact, agentName)
  }

  clearLockout(artifact: string): void {
    const canonicalArtifact = this.#canonicalPath(artifact)
    if (!canonicalArtifact) {
      throw new Error(`Reviewer lockout path must remain inside the repository: ${artifact}`)
    }
    this.#lockouts.delete(canonicalArtifact)
    for (const pipeline of this.#pipelines.values()) {
      pipeline.getReviewerLockout().clearLockout(canonicalArtifact)
    }
  }

  lockouts(): ReadonlyArray<{artifact: string; agents: string[]}> {
    return [...this.#lockouts].map(([artifact, agents]) => ({
      artifact,
      agents: [...agents].sort(),
    }))
  }
}

export const createSessionHooks = (
  agentName: string,
  pipeline: HookPipeline,
): SquadSessionHooks => ({
  onPreToolUse: async (input, invocation) => {
    const result = await pipeline.runPreToolHooks({
      toolName: input.toolName,
      arguments: toArguments(input.toolArgs),
      agentName,
      sessionId: invocation.sessionId,
    })

    if (result.action === 'block') {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: result.reason ?? 'Blocked by Squad policy.',
      }
    }
    if (result.action === 'modify' && result.modifiedArguments) {
      return {
        permissionDecision: 'allow',
        modifiedArgs: result.modifiedArguments,
      }
    }
    return {permissionDecision: 'allow'}
  },
  onPostToolUse: async (input, invocation) => {
    const result = await pipeline.runPostToolHooks({
      toolName: input.toolName,
      arguments: toArguments(input.toolArgs),
      result: input.toolResult,
      agentName,
      sessionId: invocation.sessionId,
    })

    if (!isToolResult(result.result)) {
      throw new Error(`Squad hook pipeline returned an invalid result for ${input.toolName}.`)
    }
    return {modifiedResult: result.result}
  },
})

export const formatAssistantResponse = (response: unknown): string => {
  if (typeof response !== 'object' || response === null) return 'No response returned.'
  const data = 'data' in response ? response.data : undefined
  if (typeof data !== 'object' || data === null || !('content' in data)) {
    return 'No response returned.'
  }
  return typeof data.content === 'string' ? data.content : 'No response returned.'
}
