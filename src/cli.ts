import {execute} from '@oclif/core'
import {pathToFileURL} from 'node:url'
import {renderRecoveryGuidance} from './ui/recovery-guidance.js'
import {isRootHelpRequest, renderRootHelp, unknownCommand} from './ui/command-guidance.js'

export function normalizeCliArgs(argv: readonly string[]): string[] {
  const args = Array.from(argv)
  if (args.length === 0) {
    return ['migrate']
  }
  const hasExplicitCommand =
    args[0] === 'migrate' || args[0] === 'auth' || args[0] === 'sessions' || args[0] === 'world'
  const usesSandboxEntrypoint =
    args.includes('--sandbox') ||
    args.some((arg) => arg.startsWith('--sandbox=')) ||
    args.includes('--list-sandbox-scenarios')
  return usesSandboxEntrypoint && !hasExplicitCommand ? ['migrate', ...args] : args
}

export function isSourceEntrypoint(moduleUrl: string): boolean {
  return moduleUrl.endsWith('/src/cli.ts')
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (isRootHelpRequest(argv)) {
    console.log(renderRootHelp())
    return
  }
  const unsupported = unknownCommand(argv)
  if (unsupported) {
    console.error(renderRecoveryGuidance(new Error(`command ${unsupported} not found`), argv))
    process.exitCode = 2
    return
  }
  await execute({
    args: normalizeCliArgs(argv),
    development: isSourceEntrypoint(import.meta.url),
    dir: import.meta.url,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().catch((error: unknown) => {
    console.error(renderRecoveryGuidance(error, process.argv.slice(2)))
    process.exitCode = 1
  })
}
