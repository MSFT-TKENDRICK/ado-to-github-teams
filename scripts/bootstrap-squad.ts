import {initSquad} from '@bradygaster/squad-sdk/config'
import {removeSquadUnionMergeAttributes} from './squad-gitattributes.js'
import {createSquadInitOptions} from './squad-init.js'

const teamRoot = process.cwd()
const result = await initSquad(createSquadInitOptions(teamRoot))

if (result.warnings && result.warnings.length > 0) {
  throw new Error(`Squad bootstrap warnings: ${result.warnings.join('; ')}`)
}

await removeSquadUnionMergeAttributes(teamRoot)

console.log(
  `Squad local state ready (${result.createdFiles.length} created, ${result.skippedFiles.length} existing).`,
)
