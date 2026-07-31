import {readFile} from 'node:fs/promises'

const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version
const versionLocations = [
  ['apps/cli/package.json', (document) => document.version],
  ['plugin.json', (document) => document.version],
  ['.github/plugin/marketplace.json', (document) => document.metadata.version],
  ['.github/plugin/marketplace.json', (document) => document.plugins[0].version],
]

if (!/^0\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error(`Expected a plain 0.x.x version, received ${expectedVersion}.`)
}

for (const [file, selectVersion] of versionLocations) {
  const document = JSON.parse(await readFile(file, 'utf8'))
  const actualVersion = selectVersion(document)
  if (actualVersion !== expectedVersion) {
    throw new Error(`${file} contains ${actualVersion}; expected ${expectedVersion}.`)
  }
}
