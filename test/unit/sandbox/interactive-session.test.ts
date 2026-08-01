import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {loadSandboxCatalog} from '../../../src/sandbox/config.js'
import {
  SANDBOX_EXIT_SELECTION,
  SANDBOX_GUIDE_SELECTION,
  SandboxScenarioRunnerTag,
  SandboxSessionUiTag,
  renderSandboxHelp,
  runSandboxSession,
  sandboxMigrationArgs,
} from '../../../src/sandbox/interactive-session.js'

describe('interactive sandbox session', () => {
  it('runs repeated scenarios through the delegated migration surface until explicit exit', async () => {
    const loaded = await Effect.runPromise(loadSandboxCatalog())
    const selections = [
      'happy-path',
      SANDBOX_GUIDE_SELECTION,
      'apply-happy-path',
      SANDBOX_EXIT_SELECTION,
    ]
    const lines: string[] = []
    const runs: string[] = []
    const defaults: Array<string | undefined> = []
    const layer = Layer.merge(
      Layer.succeed(SandboxSessionUiTag, {
        choose: (_scenarios, defaultScenarioId) =>
          Effect.sync(() => {
            defaults.push(defaultScenarioId)
            return selections.shift() ?? SANDBOX_EXIT_SELECTION
          }),
        writeLine: (line) => Effect.sync(() => lines.push(line)),
      }),
      Layer.succeed(SandboxScenarioRunnerTag, {
        run: (scenario) => Effect.sync(() => runs.push(scenario.id)),
      }),
    )

    await Effect.runPromise(
      runSandboxSession(loaded.catalog, {initialScenarioId: 'guest-user'}).pipe(
        Effect.provide(layer),
      ),
    )

    expect(runs).toEqual(['happy-path', 'apply-happy-path'])
    expect(defaults).toEqual(['guest-user', undefined, undefined, undefined])
    expect(lines[0]).toContain('Interactive sandbox started')
    expect(lines).toContain('Sandbox scenario contracts:')
    expect(lines.at(-1)).toBe('Sandbox session closed.')
  })

  it('derives command arguments and help from catalog scenario contracts', async () => {
    const loaded = await Effect.runPromise(loadSandboxCatalog())
    const happy = loaded.catalog.scenarios.find((scenario) => scenario.id === 'happy-path')
    const apply = loaded.catalog.scenarios.find((scenario) => scenario.id === 'apply-happy-path')

    expect(happy).toBeDefined()
    expect(apply).toBeDefined()
    if (!happy || !apply) return

    expect(sandboxMigrationArgs(happy, {detail: 'guided', tui: true})).toEqual([
      '--sandbox',
      'happy-path',
    ])
    expect(
      sandboxMigrationArgs(apply, {
        configPath: 'custom.yaml',
        detail: 'compact',
        tui: false,
      }),
    ).toEqual([
      '--sandbox',
      'apply-happy-path',
      '--apply',
      '--sandbox-config',
      'custom.yaml',
      '--detail',
      'compact',
      '--no-tui',
    ])

    const help = renderSandboxHelp(loaded.catalog)
    expect(help).toContain('a2g --sandbox <scenario>')
    expect(help).toContain('a2g migrate --sandbox <scenario>')
    expect(help).not.toContain('Pass a scenario ID after --sandbox to run it once')
    for (const scenario of loaded.catalog.scenarios) {
      expect(help).toContain(`${scenario.id} [${scenario.mode}]`)
      expect(help).toContain(scenario.title)
      expect(help).toContain(scenario.description)
    }
  })
})
