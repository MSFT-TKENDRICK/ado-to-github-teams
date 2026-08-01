import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {loadSandboxCatalog} from '../../src/sandbox/config.js'
import {executeSandboxMigration} from '../../src/sandbox/execution.js'
import {runSandboxPresentationTrace} from '../../src/sandbox/presentation-trace.js'
import {
  makeMigrationProgressLayer,
  type MigrationProgressEvent,
} from '../../src/ui/migration-progress.js'

describe('configured sandbox scenarios', () => {
  it('executes every Gherkin-backed scenario through the production orchestrator', async () => {
    const loaded = await Effect.runPromise(loadSandboxCatalog())

    for (const scenario of loaded.catalog.scenarios) {
      const directory = await mkdtemp(path.join(tmpdir(), `sandbox-${scenario.id}-`))
      try {
        const output = path.join(directory, 'report.md')
        const progressEvents: MigrationProgressEvent[] = []
        const execution = await Effect.runPromise(
          executeSandboxMigration({
            scenario,
            configDigest: loaded.digest,
            checkpointDirectory: path.join(directory, 'checkpoints'),
            progressLayer: makeMigrationProgressLayer((event) => progressEvents.push(event)),
            migration: {
              ...scenario.scope,
              apply: scenario.mode === 'apply',
              concurrency: 2,
              output,
              autoResume: false,
              runId: `sandbox-test-${scenario.id}`,
            },
            approval: {
              yesFlag: true,
              writeLine: () => Effect.void,
            },
          }),
        )
        const {result, runtime} = execution

        expect(progressEvents[0], scenario.id).toMatchObject({
          phase: 'fetch',
          status: 'running',
        })
        if (scenario.expected.outcome === 'failure') {
          expect(result._tag, scenario.id).toBe('Left')
          if (result._tag === 'Left') {
            expect(result.left._tag, scenario.id).toBe(scenario.expected.failureType)
            expect('service' in result.left ? result.left.service : undefined, scenario.id).toBe(
              scenario.expected.failureService,
            )
            expect(result.left.message, scenario.id).toContain(scenario.expected.failureIncludes)
          }
          expect(progressEvents.at(-1), scenario.id).toMatchObject({status: 'failed'})
          continue
        }

        expect(result._tag, scenario.id).toBe('Right')
        expect(progressEvents.at(-1), scenario.id).toMatchObject({
          phase: 'report',
          status: 'completed',
        })
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
        for (const [operation, count] of Object.entries(scenario.expected.callCounts ?? {})) {
          expect(runtime.callCount(operation as Parameters<typeof runtime.callCount>[0])).toBe(
            count,
          )
        }
      } finally {
        await rm(directory, {recursive: true, force: true})
      }
    }
  })

  it('derives live, blocked, failed, and complete presentation states from executed scenarios', async () => {
    const loaded = await Effect.runPromise(loadSandboxCatalog())
    const directory = await mkdtemp(path.join(tmpdir(), 'sandbox-presentation-traces-'))
    try {
      const [happy, apply, failure] = await Effect.runPromise(
        Effect.all(
          [
            runSandboxPresentationTrace({
              loaded,
              scenarioId: 'happy-path',
              directory: path.join(directory, 'happy'),
              runId: 'sandbox-evidence-happy-path',
            }),
            runSandboxPresentationTrace({
              loaded,
              scenarioId: 'apply-happy-path',
              directory: path.join(directory, 'apply'),
              runId: 'sandbox-evidence-apply-happy-path',
            }),
            runSandboxPresentationTrace({
              loaded,
              scenarioId: 'github-lookup-failure',
              directory: path.join(directory, 'failure'),
              runId: 'sandbox-evidence-github-lookup-failure',
            }),
          ],
          {concurrency: 1},
        ),
      )

      expect(
        happy.snapshots
          .filter(({origin}) => origin === 'progress')
          .map(({state}) => `${state.phase}:${state.status}`),
      ).toEqual(['fetch:running', 'map:running', 'dry-run:running', 'report:completed'])
      expect(apply.snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: 'approval',
            state: expect.objectContaining({status: 'blocked', phase: 'create-teams'}),
          }),
        ]),
      )
      expect(failure.snapshots.at(-1)?.state).toMatchObject({
        phase: 'map',
        status: 'failed',
      })
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })
})
