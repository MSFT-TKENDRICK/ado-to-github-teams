export interface EffectMigrationOptions {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly apply: boolean
  readonly output?: string
  readonly prefix?: string
  readonly suffix?: string
  readonly resume?: string
  readonly concurrency: number
  readonly topology?: {
    readonly config: import('../../types/index.js').TeamTopologyConfig
    readonly digest: string
    readonly sourcePath: string
  }
}

export type TeamMappingOptions = Pick<
  EffectMigrationOptions,
  'prefix' | 'suffix' | 'concurrency'
>
