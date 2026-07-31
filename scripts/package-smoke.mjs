import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'))
const packageManagerScript = process.env.npm_execpath

if (!packageManagerScript) {
  throw new Error('Run the packaging smoke test through pnpm')
}

const versionOutput = execFileSync(process.execPath, ['apps/cli/dist/cli.js', '--version'], {
  encoding: 'utf8',
}).trim()

if (versionOutput !== `ado-to-github-teams ${cliPackage.version}`) {
  throw new Error(`Unexpected CLI version output: ${versionOutput}`)
}

for (const [label, manifest, entrypoint] of [
  ['root', rootPackage, './bin/run.js'],
  ['staged', cliPackage, './dist/cli.js'],
]) {
  if (manifest.bin?.a2g !== entrypoint) {
    throw new Error(`${label} package does not expose a2g`)
  }
  if (manifest.bin?.['ado-to-github-teams'] !== entrypoint) {
    throw new Error(`${label} package does not retain the compatibility alias`)
  }
}

if (rootPackage.oclif?.bin !== 'a2g') {
  throw new Error('oclif help is not configured for a2g')
}

const packOutput = execFileSync(
  process.execPath,
  [packageManagerScript, '--dir', 'apps/cli', 'pack', '--dry-run', '--json'],
  {encoding: 'utf8'},
)
const manifest = JSON.parse(packOutput)
const packagedFiles = new Set(manifest.files.map(({path}) => path))

for (const requiredFile of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'package.json']) {
  if (!packagedFiles.has(requiredFile)) {
    throw new Error(`Package is missing ${requiredFile}`)
  }
}

console.log(`Validated ${manifest.filename} and CLI version output`)
