export interface EffectMigrationOptions {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly apply: boolean
  readonly output?: string
  readonly prefix?: string
  readonly suffix?: string
  readonly resume?: string
  readonly runId?: string
  readonly preserveCheckpoint?: boolean
  readonly autoResume?: boolean
  readonly workflowRunId?: string
  readonly entraActor?: import('../../types/index.js').EntraActorDescription
  readonly concurrency: number
  readonly topology?: {
    readonly config: import('../../types/index.js').TeamTopologyConfig
    readonly digest: string
  }
}

export type TeamMappingOptions = Pick<EffectMigrationOptions, 'prefix' | 'suffix' | 'concurrency'>
