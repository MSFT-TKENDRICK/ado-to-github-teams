import {execute} from '@oclif/core'
import {pathToFileURL} from 'node:url'

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await execute({
    args: argv,
    dir: import.meta.url,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}
