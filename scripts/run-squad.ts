import {confirm, input, select} from '@inquirer/prompts'
import {
  SquadClientWithPool,
  type SquadSession,
  type SquadSessionConfig,
} from '@bradygaster/squad-sdk/client'
import type {SquadCustomAgentConfig, SquadUserInputRequest} from '@bradygaster/squad-sdk/adapter'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import squadConfig from '../squad.config.ts'
import {
  createSessionHooks,
  configuredToolsForAgent,
  formatAssistantResponse,
  resolveRoutedAgents,
  SquadRuntimePolicy,
  summarizePermissionRequest,
  type SquadAgentDefinition,
} from './squad-runtime.js'

const teamRoot = process.cwd()
const squadCliEntry = join(
  teamRoot,
  'node_modules',
  '@bradygaster',
  'squad-cli',
  'dist',
  'cli-entry.js',
)
const client = new SquadClientWithPool({
  cwd: teamRoot,
  pool: {maxConcurrent: squadConfig.agents.length + 1},
})
const policy = new SquadRuntimePolicy()
const sessions = new Map<string, SquadSession>()

const promptForPermission: NonNullable<SquadSessionConfig['onPermissionRequest']> = async (
  request,
) => {
  const {summary, containsSensitiveValue} = summarizePermissionRequest(request)
  console.log('\nExact proposed permission request:')
  console.log(JSON.stringify(summary, null, 2))
  if (containsSensitiveValue) {
    console.error('Denied: the permission request contains an inline sensitive value.')
    return {kind: 'denied-interactively-by-user'}
  }
  const approved = await confirm({
    message: `Approve this ${request.kind} operation once?`,
    default: false,
  })
  return {kind: approved ? 'approve-once' : 'denied-interactively-by-user'}
}

const promptForAgentInput = async (
  request: SquadUserInputRequest,
): Promise<{answer: string; wasFreeform: boolean}> => {
  if (request.choices && request.choices.length > 0 && request.allowFreeform === false) {
    const answer = await select<string>({
      message: request.question,
      choices: request.choices.map((choice) => ({name: choice, value: choice})),
    })
    return {answer, wasFreeform: false}
  }

  const choices =
    request.choices && request.choices.length > 0 ? ` Choices: ${request.choices.join(', ')}.` : ''
  const answer = await input({message: `${request.question}${choices}`})
  return {
    answer,
    wasFreeform: request.choices ? !request.choices.includes(answer) : true,
  }
}

const modelFor = (agent: SquadAgentDefinition): string | undefined =>
  typeof agent.model === 'string' ? agent.model : agent.model?.preferred

const createAgentSession = async (
  agentName: string,
  prompt: string,
  model?: string,
  customAgents?: SquadCustomAgentConfig[],
  availableTools?: string[],
): Promise<SquadSession> =>
  client.createSession({
    clientName: `ado-to-github-teams-squad-${agentName}`,
    ...(model ? {model} : {}),
    ...(squadConfig.defaults?.reasoningEffort
      ? {reasoningEffort: squadConfig.defaults.reasoningEffort}
      : {}),
    workingDirectory: teamRoot,
    systemMessage: {mode: 'append', content: prompt},
    ...(customAgents ? {customAgents} : {}),
    ...(availableTools && availableTools.length > 0 ? {availableTools} : {}),
    hooks: createSessionHooks(agentName, policy.pipelineFor(agentName)),
    onPermissionRequest: promptForPermission,
    onUserInputRequest: promptForAgentInput,
    mcpServers: {
      squad_state: {
        type: 'stdio',
        command: process.execPath,
        args: [squadCliEntry, 'state-mcp'],
        cwd: teamRoot,
        tools: ['*'],
      },
    },
    infiniteSessions: {
      enabled: true,
      backgroundCompactionThreshold: 0.8,
      bufferExhaustionThreshold: 0.95,
    },
  })

const getAgentSession = async (agent: SquadAgentDefinition): Promise<SquadSession> => {
  const existing = sessions.get(agent.name)
  if (existing) return existing

  const prompt = `You are ${agent.name}, the ${agent.role} in the ${squadConfig.team.name}.

${agent.charter ?? ''}

Project context:
${squadConfig.team.projectContext ?? ''}

Follow AGENTS.md and repository safety rules. Use the Squad state MCP only for redacted,
non-sensitive durable context. Treat every write as approval-gated and keep expected failures
explicit.`
  const session = await createAgentSession(
    agent.name,
    prompt,
    modelFor(agent),
    undefined,
    configuredToolsForAgent(agent.name),
  )
  sessions.set(agent.name, session)
  return session
}

const getCoordinatorSession = async (): Promise<SquadSession> => {
  const existing = sessions.get('squad')
  if (existing) return existing

  const coordinatorPrompt = await readFile(
    join(teamRoot, '.github', 'agents', 'squad.agent.md'),
    'utf8',
  )
  const customAgents = squadConfig.agents.map((agent): SquadCustomAgentConfig => ({
    name: agent.name,
    displayName: `${agent.name} — ${agent.role}`,
    ...(agent.description ? {description: agent.description} : {}),
    prompt: agent.charter ?? `Act as the ${agent.role}.`,
    tools: configuredToolsForAgent(agent.name),
    infer: true,
  }))
  const session = await createAgentSession('squad', coordinatorPrompt, undefined, customAgents)
  sessions.set('squad', session)
  return session
}

const printHelp = (): void => {
  console.log(`Commands:
  /help                         Show this command list
  /agents                       Show the configured roster
  /lockout <agent> <path>       Block that agent from revising a rejected artifact
  /unlock <path>                Clear an artifact revision lockout
  /lockouts                     Show active reviewer lockouts
  /exit                         Close all SDK sessions

Address an agent by name or describe the task for deterministic routing. Unmatched work goes to
the Squad coordinator. Every permission request defaults to deny.`)
}

const handleCommand = (command: string): boolean => {
  if (command === '/help') {
    printHelp()
    return true
  }
  if (command === '/agents') {
    console.log(squadConfig.agents.map((agent) => `${agent.name}: ${agent.role}`).join('\n'))
    return true
  }
  if (command === '/lockouts') {
    const lockouts = policy.lockouts()
    console.log(
      lockouts.length === 0
        ? 'No active reviewer lockouts.'
        : lockouts.map(({artifact, agents}) => `${artifact}: ${agents.join(', ')}`).join('\n'),
    )
    return true
  }

  const lockout = /^\/lockout\s+(\S+)\s+(.+)$/.exec(command)
  if (lockout) {
    const agentName = lockout[1]
    const artifact = lockout[2]
    if (!agentName || !artifact) return false
    if (!squadConfig.agents.some((agent) => agent.name === agentName)) {
      console.error(`Unknown agent: ${agentName}`)
      return true
    }
    policy.lockout(artifact, agentName)
    console.log(`${agentName} is locked out of ${artifact} for this revision cycle.`)
    return true
  }

  const unlock = /^\/unlock\s+(.+)$/.exec(command)
  const artifact = unlock?.[1]
  if (artifact) {
    policy.clearLockout(artifact)
    console.log(`Cleared reviewer lockout for ${artifact}.`)
    return true
  }

  return false
}

await client.connect()
console.log(`SDK-first ${squadConfig.team.name} ready. Type /help for commands.`)

try {
  let running = true
  while (running) {
    const message = (await input({message: 'squad'})).trim()
    if (message.length === 0) continue
    if (message === '/exit') {
      running = false
      continue
    }
    if (handleCommand(message)) continue

    const routedAgents = resolveRoutedAgents(message)
    if (routedAgents.length === 0) {
      const session = await getCoordinatorSession()
      const response = await session.sendAndWait?.({prompt: message}, 600_000)
      console.log(`\nSquad coordinator\n${formatAssistantResponse(response)}\n`)
      continue
    }

    for (const agent of routedAgents) {
      const session = await getAgentSession(agent)
      const response = await session.sendAndWait?.({prompt: message}, 600_000)
      console.log(`\n${agent.name} — ${agent.role}\n${formatAssistantResponse(response)}\n`)
    }
  }
} finally {
  await client.shutdown()
}
