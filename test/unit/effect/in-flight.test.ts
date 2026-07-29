import {describe, expect, it} from 'vitest'
import {makeInFlightDeduplicator} from '../../../src/effect/in-flight.js'

describe('in-flight query deduplication', () => {
  it('shares concurrent reads and evicts the result after settlement', async () => {
    const deduplicator = makeInFlightDeduplicator()
    let queries = 0
    const load = async () => {
      queries += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return queries
    }

    const first = await Promise.all([
      deduplicator.run('identity:ada', load),
      deduplicator.run('identity:ada', load),
      deduplicator.run('identity:ada', load),
    ])
    const refreshed = await deduplicator.run('identity:ada', load)

    expect(first).toEqual([1, 1, 1])
    expect(refreshed).toBe(2)
    expect(queries).toBe(2)
  })
})
