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
    command:
      'ado-to-github-teams migrate --ado-org <url> --ado-project <project> --github-org <org> --foreground',
    detail: 'Dry-run is the default; review the report before any apply run.',
  },
  {
    goal: 'Check provider credentials',
    command: 'ado-to-github-teams auth --ado-org <url>',
    detail: 'Reports readiness and redacted remediation without starting a migration.',
  },
  {
    goal: 'Reopen the latest migration',
    command: 'ado-to-github-teams',
    detail: 'No arguments reopen the latest compatible durable session.',
  },
  {
    goal: 'Resolve blocked sessions',
    command: 'ado-to-github-teams sessions --blocked --select',
    detail: 'Lists retained decisions and opens the operator inbox.',
  },
  {
    goal: 'Try the CLI without credentials',
    command: 'ado-to-github-teams --sandbox happy-path',
    detail: 'Uses synthetic provider boundaries and cannot write to providers.',
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
    'ado-to-github-teams - safely migrate Azure DevOps teams to GitHub',
    '',
    'Start by task:',
    ...COMMAND_TASKS.flatMap((task) => [
      `  ${task.goal}`,
      `    ${task.command}`,
      `    ${task.detail}`,
    ]),
    '',
    'Detailed command help:',
    '  ado-to-github-teams migrate --help',
    '  ado-to-github-teams auth --help',
    '  ado-to-github-teams sessions --help',
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
