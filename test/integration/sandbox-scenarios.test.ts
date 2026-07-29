import {mkdtemp, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {makeCheckpointLayer} from '../../src/effect/layers.js'
import {runEffectMigration} from '../../src/effect/migration.js'
import {loadSandboxCatalog} from '../../src/sandbox/config.js'
import {
  makeSandboxApprovalLayer,
  makeSandboxBoundaryLayers,
  makeSandboxReportWriterLayer,
} from '../../src/sandbox/layers.js'
import {SandboxRuntime} from '../../src/sandbox/runtime.js'

describe('configured sandbox scenarios', () => {
  it('executes every Gherkin-backed scenario through the production orchestrator', async () => {
    const loaded = await Effect.runPromise(loadSandboxCatalog())

    for (const scenario of loaded.catalog.scenarios) {
      const directory = await mkdtemp(path.join(tmpdir(), `sandbox-${scenario.id}-`))
      const output = path.join(directory, 'report.md')
      const runtime = new SandboxRuntime(scenario)
      const layer = Layer.mergeAll(
        makeSandboxBoundaryLayers(runtime),
        makeSandboxApprovalLayer(runtime),
        makeCheckpointLayer(path.join(directory, 'checkpoints')),
        makeSandboxReportWriterLayer(runtime, loaded.digest),
      )
      const result = await Effect.runPromise(
        runEffectMigration({
          ...scenario.scope,
          apply: scenario.mode === 'apply',
          concurrency: 2,
          output,
        }).pipe(Effect.provide(layer), Effect.either),
      )

      await Effect.runPromise(runtime.verify())
      if (scenario.expected.outcome === 'failure') {
        expect(result._tag, scenario.id).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left._tag, scenario.id).toBe(scenario.expected.failureType)
          expect(
            'service' in result.left ? result.left.service : undefined,
            scenario.id,
          ).toBe(scenario.expected.failureService)
          expect(result.left.message, scenario.id).toContain(
            scenario.expected.failureIncludes,
          )
        }
        continue
      }

      expect(result._tag, scenario.id).toBe('Right')
      const report = await readFile(output, 'utf8')
      const behaviorReport = report.split('## Sandbox Boundary Transcript')[0] ?? report
      for (const expectedText of scenario.expected.reportIncludes ?? []) {
        expect(behaviorReport, scenario.id).toContain(expectedText)
      }
      const operations = runtime.transcript().map((entry) => entry.operation)
      let previousIndex = -1
      for (const expectedOperation of scenario.expected.transcriptIncludesInOrder ?? []) {
        const index = operations.indexOf(expectedOperation, previousIndex + 1)
        expect(index, `${scenario.id}: ${expectedOperation}`).toBeGreaterThan(previousIndex)
        previousIndex = index
      }
      for (const [operation, count] of Object.entries(
        scenario.expected.callCounts ?? {},
      )) {
        expect(runtime.callCount(operation as Parameters<typeof runtime.callCount>[0])).toBe(
          count,
        )
      }
    }
  })
})
