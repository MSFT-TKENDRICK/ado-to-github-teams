import {Schema} from 'effect'

const CommandTaskSchema = Schema.Struct({
  goal: Schema.String,
  command: Schema.String,
  detail: Schema.String,
})

export type CommandTask = Schema.Schema.Type<typeof CommandTaskSchema>

export const COMMAND_TASKS = Schema.decodeUnknownSync(Schema.Array(CommandTaskSchema))([
  {
    goal: 'Preview a migration safely',
    command: 'a2g migrate --ado-org <url> --ado-project <project> --github-org <org> --foreground',
    detail: 'Dry-run is the default; review the report before any apply run.',
  },
  {
    goal: 'Check provider credentials',
    command: 'a2g auth --ado-org <url>',
    detail: 'Reports readiness and redacted remediation without starting a migration.',
  },
  {
    goal: 'Reopen the latest migration',
    command: 'a2g',
    detail: 'No arguments reopen the latest compatible durable session.',
  },
  {
    goal: 'Resolve blocked sessions',
    command: 'a2g sessions --blocked --select',
    detail: 'Lists retained decisions and opens the operator inbox.',
  },
  {
    goal: 'Record a durable deployment preference',
    command: 'a2g world',
    detail: 'Local is the default; Azure preflight requires sign-in and subscription discovery.',
  },
  {
    goal: 'Try the CLI without credentials',
    command: 'a2g sandbox',
    detail: 'Persistent interactive session; only provider services use predefined responses.',
  },
])

export function renderCliCommand(arguments_: readonly string[]): string {
  return arguments_
    .map((argument) =>
      /^[\w./:=@<>-]+$/u.test(argument)
        ? argument
        : `"${argument.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
    )
    .join(' ')
}

export function renderRootHelp(): string {
  return [
    'a2g - safely migrate Azure DevOps teams to GitHub',
    '',
    'Start by task:',
    ...COMMAND_TASKS.flatMap((task) => [
      `  ${task.goal}`,
      `    ${task.command}`,
      `    ${task.detail}`,
    ]),
    '',
    'Detailed command help:',
    '  a2g migrate --help',
    '  a2g auth --help',
    '  a2g sessions --help',
    '  a2g world --help',
    '  a2g sandbox --help',
    '',
    'Safety: dry-run is the default. Live writes require --apply and recorded approval.',
  ].join('\n')
}

export function isRootHelpRequest(argv: readonly string[]): boolean {
  return argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')
}

export function isUnknownCommandError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /command .* not found|unknown command|not a command/iu.test(error.message)
  )
}

export function unknownCommand(argv: readonly string[]): string | undefined {
  const command = argv[0]
  if (
    !command ||
    command.startsWith('-') ||
    command === 'help' ||
    ['migrate', 'auth', 'sessions', 'world', 'sandbox'].includes(command)
  ) {
    return undefined
  }
  return command
}
