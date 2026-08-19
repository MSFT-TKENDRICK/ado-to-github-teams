import {defineConfig} from 'vitest/config'

/**
 * Vitest configuration used only by Stryker (`pnpm test:mutation`).
 *
 * It deliberately differs from the root config in two ways:
 *
 * 1. Only `test/unit` is included. Mutation testing re-executes the suite once per surviving
 *    mutant, so the contract and integration suites — which boot Pact mock servers, provider apps
 *    and spawned processes — would dominate the run time without improving the mutation score of
 *    the pure domain modules being mutated.
 * 2. No coverage block. Stryker performs its own `perTest` coverage analysis to decide which tests
 *    can kill which mutant; a second instrumentation pass would conflict with it and the
 *    thresholds would fire spuriously against a mutated source tree.
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
  },
})
