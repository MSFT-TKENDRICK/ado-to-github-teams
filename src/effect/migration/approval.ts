import {Effect} from 'effect'
import type {ApprovalRequest} from '../../types/index.js'
import {ApprovalServiceTag} from '../services.js'
import type {MigrationStateStore} from './state-store.js'

export function requestCheckpointedApproval(store: MigrationStateStore, request: ApprovalRequest) {
  return Effect.gen(function* () {
    const approval = yield* ApprovalServiceTag
    const approved = yield* approval.request(request)
    const state = yield* store.get
    yield* store.save({
      ...state,
      approvalHistory: yield* approval.history,
    })
    return approved
  })
}
