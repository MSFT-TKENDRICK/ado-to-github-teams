import {createHash} from 'node:crypto'
import {CHECKPOINT_SCHEMA_VERSION} from '../types/index.js'

export {CHECKPOINT_SCHEMA_VERSION} from '../types/index.js'

export interface MigrationConfiguration {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly apply: boolean
  readonly prefix?: string
  readonly suffix?: string
}

export function configurationHash(configuration: MigrationConfiguration): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        adoOrg: configuration.adoOrg,
        adoProject: configuration.adoProject,
        githubOrg: configuration.githubOrg,
        prefix: configuration.prefix ?? null,
        suffix: configuration.suffix ?? null,
      }),
    )
    .digest('hex')
}
