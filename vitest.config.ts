import {defineConfig} from 'vitest/config'

/**
 * Coverage provider selection.
 *
 * `v8` and `istanbul` do NOT agree on this codebase, and the gap is large enough that a coverage
 * threshold is meaningless unless the provider is pinned. Measured on the same `test/unit` run:
 *
 * | provider | statements     | branches       | functions   | lines          |
 * | -------- | -------------- | -------------- | ----------- | -------------- |
 * | v8       | 65.59%         | 78.14%         | 73.98%      | 65.59%         |
 * |          | (12661/19302)  | (2370/3033)    | (549/742)   | (12661/19302)  |
 * | istanbul | 59.74%         | 51.88%         | 59.77%      | 59.52%         |
 * |          | (3665/6134)    | (2317/4466)    | (914/1529)  | (3562/5984)    |
 *
 * The 26-point branch spread is not noise, and the denominators are not even the same unit. `v8`
 * maps bytecode coverage back through source maps, so source-level branches that the
 * TypeScript/esbuild pipeline collapses — and the many implicit branches Effect's generator
 * plumbing emits — are never counted; it finds ~32% fewer branches to begin with. `istanbul`
 * instruments the TypeScript AST directly and reports the more faithful *source-level* branch
 * picture, at the cost of a slower transform.
 *
 * `v8` is the pinned default because it matches the existing esbuild/tsx pipeline with no extra
 * instrumentation cost. `COVERAGE_PROVIDER=istanbul` runs the stricter source-level audit. Only
 * ever compare a number against another number produced by the same provider.
 */
const coverageProvider = process.env.COVERAGE_PROVIDER === 'istanbul' ? 'istanbul' : 'v8'

/**
 * Per-directory floors.
 *
 * Adapter and process-entrypoint code sits lower for a structural reason: AGENTS.md forbids unit
 * tests from calling live services, so `src/services`, `src/auth`, `src/commands` and `src/azure`
 * are covered by `test/contract`, `test/chaos` and `test/integration` instead. Some of it executes
 * only in a spawned process (`package:smoke`, the Pact provider apps) or inside the deployed Azure
 * Functions host, which in-process instrumentation cannot observe at all.
 *
 * NOTE: glob thresholds are ADDITIVE guards, not exclusions. Verified empirically — the global
 * numbers below are still computed over the whole of `src`, including every file matched here.
 * These exist to catch one directory sliding while the overall number stays flat.
 *
 * The floors sit well below the measured values on purpose. Across three identical `test:cov`
 * runs (964 passing tests every time, zero failures) the v8 provider reported 82.37%, 81.43% and
 * 82.37% overall, and `src/workflow` swung between 78.0% and 68.3% — worker coverage reports are
 * merged per process and that merge is not perfectly deterministic. A floor set at
 * measured-minus-one would produce a red build for reasons unrelated to the tests, which is the
 * fastest way to get a coverage gate disabled. Treat a one- or two-point move as noise; treat a
 * threshold breach as a real regression.
 *
 * Every floor is a RATCHET: raise it when coverage genuinely improves, never lower it to make a
 * branch pass.
 */
const directoryThresholds = {
  // Measured 57.3% lines / 56.3% branches / 66.7% functions. oclif command shells; much of
  // `migrate.ts` only executes against live ADO/GitHub services.
  '**/src/commands/**': {lines: 50, statements: 50, functions: 58, branches: 48},
  // Measured 66.6% / 83.1% / 82.1%. Interactive, broker and device-code credential flows cannot
  // be driven headlessly.
  '**/src/auth/**': {lines: 58, statements: 58, functions: 74, branches: 75},
  // Measured 78.0% / 86.1% / 81.9%, with the widest observed run-to-run swing in the repository.
  '**/src/workflow/**': {lines: 65, statements: 65, functions: 72, branches: 78},
  // Measured 79.2% / 83.8% / 76.7%.
  '**/src/effect/**': {lines: 71, statements: 71, functions: 69, branches: 76},
  // Measured 81.3% / 75.0% / 83.3%.
  '**/src/sandbox/**': {lines: 73, statements: 73, functions: 75, branches: 67},
  // Measured 89.8% / 86.9% / 90.0%. ADO, GitHub and Graph SDK adapters.
  '**/src/services/**': {lines: 82, statements: 82, functions: 82, branches: 79},
  // Azure Functions host binding — executed only by the deployed host, never in-process.
  '**/src/azure/**': {lines: 0, statements: 0, functions: 0, branches: 0},
  '**/src/plugins/**': {lines: 0, statements: 0, functions: 0, branches: 0},
  // `cli.ts` / `worker.ts` process entrypoints. Measured 50.3% lines / 73.7% branches; the
  // remainder runs in spawned processes that in-process coverage cannot see.
  '**/src/*.ts': {lines: 42, statements: 42, functions: 84, branches: 65},
  // Domain code that is already strong — these floors protect it from regressing.
  '**/src/experience/**': {lines: 89, statements: 89, functions: 90, branches: 84},
  '**/src/healing/**': {lines: 93, statements: 93, functions: 95, branches: 88},
  '**/src/utils/**': {lines: 91, statements: 91, functions: 95, branches: 88},
  '**/src/reporters/**': {lines: 94, statements: 94, functions: 95, branches: 84},
  '**/src/ui/**': {lines: 87, statements: 87, functions: 88, branches: 79},
  '**/src/checkpoints/**': {lines: 84, statements: 84, functions: 85, branches: 80},
  '**/src/plans/**': {lines: 75, statements: 75, functions: 78, branches: 75},
  '**/src/mappers/**': {lines: 79, statements: 79, functions: 95, branches: 71},
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    coverage: {
      provider: coverageProvider,
      // Count files no test imports. Without this the denominator silently shrinks to "files a
      // test happened to touch" and the percentage flatters the suite.
      all: true,
      include: ['src/**/*.ts'],
      // Type-only modules emit no executable statements; including them reports a misleading 100%.
      exclude: ['src/types/**'],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'reports/coverage',
      /**
       * Global thresholds, measured across `test:cov` (unit + integration + contract + chaos) with
       * the v8 provider: 82.37% lines/statements, 82.97% branches, 86.65% functions, over three
       * runs ranging 81.43%–82.37%.
       *
       * All three metrics clear the 80% goal, so 80 is the enforced floor rather than an
       * aspiration. It is a RATCHET — raise it as coverage improves, never lower it to make a
       * branch pass.
       *
       * Two caveats keep the number honest. Coverage is blind to anything running outside the
       * vitest process, so `package:smoke`, the Pact provider apps, and the entire Cucumber suite
       * (`test:bdd` runs through `tsx`) contribute nothing here. And `test/contract` is skipped
       * wholesale on platforms with no Pact FFI prebuild, so a local run on win32/arm64 reports
       * slightly lower than CI does.
       */
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 84,
        branches: 80,
        ...directoryThresholds,
      },
    },
  },
})
