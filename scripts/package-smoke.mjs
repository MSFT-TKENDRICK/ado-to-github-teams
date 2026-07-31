import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {isAbsolute, join} from 'node:path'

const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'))
const packageManagerScript = process.env.npm_execpath

if (!packageManagerScript) {
  throw new Error('Run the packaging smoke test through a package-manager script')
}

function npmPackManifest(args, cwd = process.cwd()) {
  const output = execFileSync(process.execPath, [packageManagerScript, 'pack', ...args], {
    cwd,
    encoding: 'utf8',
  })
  const parsed = JSON.parse(output)
  const manifest = Array.isArray(parsed) ? parsed[0] : parsed
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new Error('Package manager returned an invalid pack manifest')
  }
  return manifest
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

if (rootPackage.publishConfig?.access !== 'public') {
  throw new Error('Scoped root package must publish with public access')
}

if (
  rootPackage.repository?.url !== 'git+https://github.com/MSFT-TKENDRICK/ado-to-github-teams.git'
) {
  throw new Error('Root package repository must match the trusted publishing repository')
}

const rootManifest = npmPackManifest(['--dry-run', '--json'])
const rootPackagedFiles = new Set(rootManifest.files.map(({path}) => path))

for (const requiredFile of ['bin/run.js', 'dist/cli.js', 'package.json', 'README.md']) {
  if (!rootPackagedFiles.has(requiredFile)) {
    throw new Error(`Root package is missing ${requiredFile}`)
  }
}

const smokeDirectory = mkdtempSync(join(process.cwd(), 'node_modules', '.a2g-package-smoke-'))
try {
  const packedRootManifest = npmPackManifest(['--json', '--pack-destination', smokeDirectory])
  const packedRootArchive = isAbsolute(packedRootManifest.filename)
    ? packedRootManifest.filename
    : join(smokeDirectory, packedRootManifest.filename)
  execFileSync('tar', [
    '--extract',
    '--gzip',
    '--file',
    packedRootArchive,
    '--directory',
    smokeDirectory,
  ])

  const packedEntrypoint = join(smokeDirectory, 'package', 'bin', 'run.js')
  const helpOutput = execFileSync(process.execPath, [packedEntrypoint, '--help'], {
    encoding: 'utf8',
  })
  if (!helpOutput.startsWith('a2g -') || !helpOutput.includes('a2g world --help')) {
    throw new Error('Packed root CLI help does not identify a2g')
  }

  const worldHelpOutput = execFileSync(process.execPath, [packedEntrypoint, 'world', '--help'], {
    encoding: 'utf8',
  })
  if (
    !worldHelpOutput.includes('a2g world') ||
    !worldHelpOutput.toLowerCase().includes('deployment preflight')
  ) {
    throw new Error('Packed world help does not describe the a2g deployment preflight')
  }
} finally {
  rmSync(smokeDirectory, {recursive: true, force: true})
}

const manifest = npmPackManifest(['--dry-run', '--json'], join(process.cwd(), 'apps', 'cli'))
const packagedFiles = new Set(manifest.files.map(({path}) => path))

for (const requiredFile of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'package.json']) {
  if (!packagedFiles.has(requiredFile)) {
    throw new Error(`Package is missing ${requiredFile}`)
  }
}

console.log(
  `Validated ${rootManifest.filename}, ${manifest.filename}, CLI version output, and extracted tarball help`,
)
