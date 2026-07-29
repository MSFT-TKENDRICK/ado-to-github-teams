import {spawn} from 'node:child_process'
import {mkdir, rm} from 'node:fs/promises'
import path from 'node:path'
import {renderCucumberReport} from './render-cucumber-report.js'

const root = process.cwd()
const reportsDirectory = path.join(root, 'reports')
const jsonPath = path.join(reportsDirectory, 'cucumber.json')
const markdownPath = path.join(reportsDirectory, 'cucumber.md')
const featuresPath = path.join(root, 'test', 'bdd', 'features')
const cucumberBin = path.join(
  root,
  'node_modules',
  '@cucumber',
  'cucumber',
  'bin',
  'cucumber.js',
)

await mkdir(reportsDirectory, {recursive: true})
await rm(jsonPath, {force: true})

const args = [
  '--import',
  'tsx',
  cucumberBin,
  'test/bdd/features/**/*.feature',
  '--import',
  'test/bdd/steps/**/*.ts',
  '--format',
  'progress',
  '--format',
  `"json":"${jsonPath}"`,
  '--tags',
  'not @manual',
]

const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', (code) => resolve(code ?? 1))
})

await renderCucumberReport(jsonPath, markdownPath, featuresPath)
process.exitCode = exitCode
