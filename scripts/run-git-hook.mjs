import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function run(modulePath, args, environment = {}) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(modulePath, import.meta.url)), ...args],
    {
      cwd: root,
      env: {...process.env, ...environment},
      stdio: 'inherit',
    },
  )

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const [hook, ...files] = process.argv.slice(2)

switch (hook) {
  case 'format-staged':
    run('../node_modules/prettier/bin/prettier.cjs', ['--check', ...files])
    break
  case 'lint-staged':
    run('../node_modules/eslint/bin/eslint.js', files)
    break
  case 'secrets':
    run('../node_modules/varlock/bin/cli.js', ['scan'], {VARLOCK_TELEMETRY_DISABLED: '1'})
    break
  case 'dx-gate':
    run('../node_modules/prettier/bin/prettier.cjs', [
      '--check',
      'src/**/*.ts',
      'test/**/*.ts',
      'scripts/**/*.ts',
      'skills/**/*.ts',
      'squad.config.ts',
    ])
    run('../node_modules/eslint/bin/eslint.js', [
      'src',
      'test',
      'scripts',
      'skills',
      'squad.config.ts',
      '--ext',
      '.ts',
    ])
    run('../node_modules/typescript/bin/tsc', ['-p', 'tsconfig.eslint.json', '--noEmit'])
    run('../node_modules/vitest/vitest.mjs', ['run', 'test/unit'])
    break
  default:
    throw new Error(`Unknown git hook command: ${hook ?? '(missing)'}`)
}
