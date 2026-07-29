import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'

async function manager(): Promise<CheckpointManager> {
  const directory = await mkdtemp(path.join(tmpdir(), 'leases-'))
  return new CheckpointManager(path.join(directory, 'workflow.db'))
}

const T0 = '2026-07-29T12:00:00.000Z'
const T_PLUS_30S = '2026-07-29T12:00:30.000Z'
const T_PLUS_2M = '2026-07-29T12:02:00.000Z'
const T_PLUS_4M = '2026-07-29T12:04:00.000Z'
const EXPIRES_AT_T0 = '2026-07-29T12:01:00.000Z'
const EXPIRES_LATER = '2026-07-29T12:03:00.000Z'

describe('durable migration lease', () => {
  it('grants a single holder and blocks a concurrent worker', async () => {
    const store = await manager()
    const results = await Promise.all([
      store.acquireMigrationLease('run:apply', 'worker-a', T0, EXPIRES_AT_T0),
      store.acquireMigrationLease('run:apply', 'worker-b', T0, EXPIRES_AT_T0),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('is re-entrant for the same owner', async () => {
    const store = await manager()
    expect(await store.acquireMigrationLease('run:apply', 'worker-a', T0, EXPIRES_AT_T0)).toBe(true)
    expect(
      await store.acquireMigrationLease('run:apply', 'worker-a', T_PLUS_30S, EXPIRES_LATER),
    ).toBe(true)
  })

  it('lets another worker reclaim the lease only after it expires', async () => {
    const store = await manager()
    await store.acquireMigrationLease('run:apply', 'worker-a', T0, EXPIRES_AT_T0)

    // Before expiry the lease is protected.
    expect(
      await store.acquireMigrationLease('run:apply', 'worker-b', T_PLUS_30S, EXPIRES_LATER),
    ).toBe(false)

    // After the crashed holder's lease expires it becomes reclaimable.
    expect(
      await store.acquireMigrationLease('run:apply', 'worker-b', T_PLUS_2M, EXPIRES_LATER),
    ).toBe(true)
  })

  it('renews only for the current owner and rejects a reclaimed renewal', async () => {
    const store = await manager()
    await store.acquireMigrationLease('run:apply', 'worker-a', T0, EXPIRES_AT_T0)
    // Heartbeat extends the expiry to T+3m.
    expect(
      await store.renewMigrationLease('run:apply', 'worker-a', T_PLUS_30S, EXPIRES_LATER),
    ).toBe(true)

    // worker-b can only reclaim after the renewed expiry (T+3m) elapses.
    await store.acquireMigrationLease('run:apply', 'worker-b', T_PLUS_4M, EXPIRES_LATER)
    expect(await store.renewMigrationLease('run:apply', 'worker-a', T_PLUS_4M, EXPIRES_LATER)).toBe(
      false,
    )
  })

  it('releases the lease so a new holder can acquire immediately', async () => {
    const store = await manager()
    await store.acquireMigrationLease('run:apply', 'worker-a', T0, EXPIRES_AT_T0)
    await store.releaseMigrationLease('run:apply', 'worker-a')

    expect(
      await store.acquireMigrationLease('run:apply', 'worker-b', T_PLUS_30S, EXPIRES_LATER),
    ).toBe(true)
  })

  it('does not release a lease already reclaimed by another worker', async () => {
    const store = await manager()
    await store.acquireMigrationLease('run:apply', 'worker-a', T0, EXPIRES_AT_T0)
    await store.acquireMigrationLease('run:apply', 'worker-b', T_PLUS_2M, EXPIRES_LATER)

    // Late release from the evicted worker is a no-op; worker-b keeps the lease.
    await store.releaseMigrationLease('run:apply', 'worker-a')
    expect(await store.renewMigrationLease('run:apply', 'worker-b', T_PLUS_2M, EXPIRES_LATER)).toBe(
      true,
    )
  })

  it('isolates leases for different phases of the same run', async () => {
    const store = await manager()
    expect(await store.acquireMigrationLease('run:prepare', 'worker-a', T0, EXPIRES_AT_T0)).toBe(
      true,
    )
    expect(await store.acquireMigrationLease('run:apply', 'worker-b', T0, EXPIRES_AT_T0)).toBe(true)
  })
})
