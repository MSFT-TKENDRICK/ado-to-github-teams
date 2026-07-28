import type {Effect} from 'effect'
import type {CheckpointState} from '../../types/index.js'
import type {DomainFailure} from '../errors.js'

export interface MigrationStateStore {
  readonly get: Effect.Effect<CheckpointState>
  readonly save: (state: CheckpointState) => Effect.Effect<void, DomainFailure>
}
