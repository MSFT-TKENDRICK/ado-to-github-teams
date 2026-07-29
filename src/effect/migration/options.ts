import type {ApplyBatchLimits} from './budget.js'

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
  readonly concurrency: number
  /**
   * Bounds each apply invocation to a resumable slice of destructive work.
   * Omitted for dry-runs and single-shot callers, which process everything.
   */
  readonly applyBatch?: ApplyBatchLimits
  readonly topology?: {
    readonly config: import('../../types/index.js').TeamTopologyConfig
    readonly digest: string
  }
}

export type TeamMappingOptions = Pick<EffectMigrationOptions, 'prefix' | 'suffix' | 'concurrency'>
