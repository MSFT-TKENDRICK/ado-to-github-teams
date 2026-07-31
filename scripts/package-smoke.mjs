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

if (rootPackage.name !== '@msft-tkendrick/a2g') {
  throw new Error('Unexpected root package name')
}

const helpOutput = execFileSync(process.execPath, ['bin/run.js', '--help'], {
  encoding: 'utf8',
})
if (!helpOutput.startsWith('a2g -') || !helpOutput.includes('a2g world --help')) {
  throw new Error('Packaged root CLI help does not identify a2g')
}

const worldHelpOutput = execFileSync(process.execPath, ['bin/run.js', 'world', '--help'], {
  encoding: 'utf8',
})
if (
  !worldHelpOutput.includes('a2g world') ||
  !worldHelpOutput.toLowerCase().includes('deployment preflight')
) {
  throw new Error('Packaged world help does not describe the a2g deployment preflight')
}

if (rootPackage.publishConfig?.access !== 'public') {
  throw new Error('Scoped root package must publish with public access')
}

if (
  rootPackage.repository?.url !== 'git+https://github.com/MSFT-TKENDRICK/ado-to-github-teams.git'
) {
  throw new Error('Root package repository must match the trusted publishing repository')
}

const rootPackOutput = execFileSync(
  process.execPath,
  [packageManagerScript, 'pack', '--dry-run', '--json'],
  {encoding: 'utf8'},
)
const rootManifest = JSON.parse(rootPackOutput)
const rootPackagedFiles = new Set(rootManifest.files.map(({path}) => path))

for (const requiredFile of ['bin/run.js', 'dist/cli.js', 'package.json', 'README.md']) {
  if (!rootPackagedFiles.has(requiredFile)) {
    throw new Error(`Root package is missing ${requiredFile}`)
  }
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

console.log(
  `Validated ${rootManifest.filename}, ${manifest.filename}, CLI version output, and shipped help`,
)
