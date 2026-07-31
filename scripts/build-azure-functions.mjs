import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'

const outputDirectory = path.resolve('.azure-functions')
const packageDocument = JSON.parse(await readFile('package.json', 'utf8'))
const functionPackage = {
  name: '@msft-tkendrick/a2g-functions',
  version: packageDocument.version,
  private: true,
  type: 'module',
  main: 'dist/azure/functions.js',
  engines: packageDocument.engines,
  dependencies: packageDocument.dependencies,
}

await rm(outputDirectory, {recursive: true, force: true})
await mkdir(path.join(outputDirectory, '.workflow-data', 'build'), {recursive: true})
await Promise.all([
  cp('dist', path.join(outputDirectory, 'dist'), {recursive: true}),
  cp(
    path.join('.workflow-data', 'build', 'workflow'),
    path.join(outputDirectory, '.workflow-data', 'build', 'workflow'),
    {recursive: true},
  ),
  cp('host.json', path.join(outputDirectory, 'host.json')),
  writeFile(
    path.join(outputDirectory, 'package.json'),
    `${JSON.stringify(functionPackage, null, 2)}\n`,
    'utf8',
  ),
])
