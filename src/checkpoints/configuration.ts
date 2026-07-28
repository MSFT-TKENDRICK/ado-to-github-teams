import {createHash} from 'node:crypto'

export const CHECKPOINT_SCHEMA_VERSION = 1 as const

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
        apply: configuration.apply,
        prefix: configuration.prefix ?? null,
        suffix: configuration.suffix ?? null,
      }),
    )
    .digest('hex')
}
