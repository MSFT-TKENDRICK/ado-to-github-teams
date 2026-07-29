import {describe, expect, it} from 'vitest'
import {migrationScopeLeaseId} from '../../../src/background/worker.js'

describe('migration worker scope lease', () => {
  it('serializes the same migration scope independently of run id', () => {
    const first = migrationScopeLeaseId('ado', 'project', 'github')
    const reopened = migrationScopeLeaseId('ado', 'project', 'github')
    const otherProject = migrationScopeLeaseId('ado', 'other', 'github')

    expect(reopened).toBe(first)
    expect(otherProject).not.toBe(first)
  })
})
