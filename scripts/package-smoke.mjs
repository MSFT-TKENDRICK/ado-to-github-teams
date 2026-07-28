import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'

const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8'))
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
