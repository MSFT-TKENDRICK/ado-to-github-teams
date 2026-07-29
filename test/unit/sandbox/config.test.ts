import {readFile} from 'node:fs/promises'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {defaultSandboxCatalogPath, loadSandboxCatalog} from '../../../src/sandbox/config.js'

describe('sandbox catalog', () => {
  it('provides one fixture for every tagged Gherkin scenario', async () => {
    const loaded = await Effect.runPromise(loadSandboxCatalog())
    const feature = await readFile(
      new URL('../../../sandbox/migration.feature', import.meta.url),
      'utf8',
    )
    const featureScenarios = Array.from(
      feature.matchAll(/@sandbox-([a-z0-9-]+)\s+Scenario:\s+([^\r\n]+)/g),
      (match) => ({id: match[1], title: match[2]?.trim()}),
    )
    const taggedScenarioIds = featureScenarios.map(({id}) => id)
    const fixtureIds = loaded.catalog.scenarios.map((scenario) => scenario.id)

    expect(new Set(fixtureIds)).toEqual(new Set(taggedScenarioIds))
    for (const scenario of loaded.catalog.scenarios) {
      const featureScenario = featureScenarios.find(({id}) => id === scenario.id)
      expect(scenario.gherkin).toBe(`sandbox/migration.feature:${featureScenario?.title ?? ''}`)
    }
    expect(loaded.path).toBe(defaultSandboxCatalogPath())
    expect(loaded.digest).toMatch(/^[a-f0-9]{64}$/)
  })
})
