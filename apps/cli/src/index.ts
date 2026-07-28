export const cliName = 'ado-to-github-teams'
export const cliVersion = '0.1.0'

export interface CliIO {
  readonly stdout: (message: string) => void
  readonly stderr: (message: string) => void
}

const usage = `Usage: ado-to-github-teams [options]

Foundation commands:
  --help       Show this help
  --version    Show the CLI version

Migration commands are delivered in later layers.`

export const runCli = (
  args: readonly string[],
  io: CliIO = {
    stdout: console.log,
    stderr: console.error,
  },
): number => {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    io.stdout(usage)
    return 0
  }

  if (args.includes('--version') || args.includes('-v')) {
    io.stdout(`${cliName} ${cliVersion}`)
    return 0
  }

  io.stderr(`Unknown option: ${args[0] ?? ''}`)
  io.stderr(`Run "${cliName} --help" for usage.`)
  return 2
}
