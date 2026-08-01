import {execute} from '@oclif/core'
import {pathToFileURL} from 'node:url'
import {Effect} from 'effect'
import {loadSandboxCatalog} from './sandbox/config.js'
import {renderSandboxHelp} from './sandbox/interactive-session.js'
import {renderRecoveryGuidance} from './ui/recovery-guidance.js'
import {isRootHelpRequest, renderRootHelp, unknownCommand} from './ui/command-guidance.js'

export function normalizeCliArgs(argv: readonly string[]): string[] {
  const args = Array.from(argv)
  if (args.length === 0) {
    return ['migrate']
  }
  if (args[0] === '--sandbox' && (args.length === 1 || args[1]?.startsWith('-'))) {
    return ['sandbox', ...args.slice(1)]
  }
  const hasExplicitCommand =
    args[0] === 'migrate' ||
    args[0] === 'auth' ||
    args[0] === 'sessions' ||
    args[0] === 'world' ||
    args[0] === 'sandbox'
  const usesSandboxEntrypoint =
    args.includes('--sandbox') ||
    args.some((arg) => arg.startsWith('--sandbox=')) ||
    args.includes('--list-sandbox-scenarios')
  return usesSandboxEntrypoint && !hasExplicitCommand ? ['migrate', ...args] : args
}

export function isSourceEntrypoint(moduleUrl: string): boolean {
  return moduleUrl.endsWith('/src/cli.ts')
}

export function isSandboxHelpRequest(argv: readonly string[]): boolean {
  return (
    (argv[0] === 'sandbox' || argv[0] === '--sandbox') &&
    argv.some((argument) => argument === '--help' || argument === '-h')
  )
}

export function sandboxConfigPath(argv: readonly string[]): string | undefined {
  const equalsValue = argv.find((argument) => argument.startsWith('--sandbox-config='))
  if (equalsValue) {
    return equalsValue.slice('--sandbox-config='.length)
  }
  const index = argv.indexOf('--sandbox-config')
  const value = index >= 0 ? argv[index + 1] : undefined
  return value && !value.startsWith('-') ? value : undefined
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (isSandboxHelpRequest(argv)) {
    const loaded = await Effect.runPromise(loadSandboxCatalog(sandboxConfigPath(argv)))
    console.log(renderSandboxHelp(loaded.catalog))
    return
  }
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
