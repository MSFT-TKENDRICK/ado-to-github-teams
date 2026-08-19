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
 * Adapter and process-entrypoint code sits low for a structural reason, not a negligent one:
 * AGENTS.md forbids unit tests from calling live services, so `src/services`, `src/auth`,
 * `src/commands` and `src/azure` are covered by `test/contract`, `test/chaos` and
 * `test/integration` instead. Several are additionally exercised only in a spawned process
 * (`package:smoke`, the Pact provider apps) or by the deployed Azure Functions host, which
 * in-process instrumentation cannot observe at all.
 *
 * NOTE: glob thresholds are ADDITIVE guards, not exclusions. Verified empirically — the global
 * numbers below are still computed over the whole of `src`, including every file matched here.
 * They exist to stop one directory sliding while the overall number stays flat.
 *
 * Every value is a measured floor with a small margin, and every one is a RATCHET: raise it when
 * coverage improves, never lower it to make a branch pass.
 */
const directoryThresholds = {
  // Measured 39.6% lines / 58.2% branches / 38.3% functions. ADO, GitHub and Graph SDK adapters.
  '**/src/services/**': {lines: 36, statements: 36, functions: 35, branches: 55},
  // Measured 56.8% / 74.2% / 69.2%. Interactive and broker credential flows.
  '**/src/auth/**': {lines: 54, statements: 54, functions: 66, branches: 71},
  // Measured 41.8% / 76.5% / 67.9%. oclif command shells.
  '**/src/commands/**': {lines: 39, statements: 39, functions: 64, branches: 73},
  // Measured 48.7% / 76.5% / 50.6%. Durable orchestration and step runtime.
  '**/src/workflow/**': {lines: 46, statements: 46, functions: 48, branches: 73},
  // Azure Functions host binding — executed only by the deployed host, never in-process.
  '**/src/azure/**': {lines: 0, statements: 0, functions: 0, branches: 0},
  '**/src/plugins/**': {lines: 0, statements: 0, functions: 0, branches: 0},
  // `cli.ts` / `worker.ts` process entrypoints. Measured 13.9% lines but 84.4% branches: their
  // bodies run in spawned processes that in-process coverage cannot see.
  '**/src/*.ts': {lines: 10, statements: 10, functions: 78, branches: 80},
  // Domain code that is already strong — these floors protect it from regressing.
  '**/src/experience/**': {lines: 92, statements: 92, functions: 92, branches: 87},
  '**/src/ui/**': {lines: 86, statements: 86, functions: 89, branches: 81},
  '**/src/reporters/**': {lines: 96, statements: 96, functions: 97, branches: 87},
  '**/src/mappers/**': {lines: 82, statements: 82, functions: 97, branches: 74},
  '**/src/utils/**': {lines: 86, statements: 86, functions: 85, branches: 83},
  '**/src/checkpoints/**': {lines: 80, statements: 80, functions: 84, branches: 79},
  '**/src/effect/**': {lines: 75, statements: 75, functions: 74, branches: 78},
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
       * the v8 provider: 72.15% lines/statements, 80.59% branches, 77.97% functions.
       *
       * Branches already clear 80%. Lines do not, and the remaining gap is concentrated in
       * `src/workflow`, `src/commands`, `src/services` and the process entrypoints — code the
       * architecture rules deliberately keep out of unit tests, plus code that only ever executes
       * in a spawned process. Closing it means more contract and integration scenarios, not more
       * unit tests; raise these floors as that work lands.
       */
      thresholds: {
        lines: 71,
        statements: 71,
        functions: 76,
        branches: 79,
        ...directoryThresholds,
      },
    },
  },
})
