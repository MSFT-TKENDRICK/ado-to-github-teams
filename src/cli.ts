import {execute} from '@oclif/core'
import {pathToFileURL} from 'node:url'

export function normalizeCliArgs(argv: readonly string[]): string[] {
  const args = Array.from(argv)
  if (args.length === 0) {
    return ['migrate']
  }
  const hasExplicitCommand =
    args[0] === 'migrate' || args[0] === 'auth' || args[0] === 'sessions'
  const usesSandboxEntrypoint =
    args.includes('--sandbox') ||
    args.some((arg) => arg.startsWith('--sandbox=')) ||
    args.includes('--list-sandbox-scenarios')
  return usesSandboxEntrypoint && !hasExplicitCommand ? ['migrate', ...args] : args
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await execute({
    args: normalizeCliArgs(argv),
    dir: import.meta.url,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
