// Audit item 7: the Pact contract quality gate must never silently pass with
// zero provider verifications. Every contract spec file is gated by the same
// `pactSupported` (win32/arm64) check used inside the test files themselves
// (see e.g. `test/contract/workflow-worker-provider.test.ts`), so this script
// mirrors that check: on a supported platform (always true on the CI runner,
// `ubuntu-24.04`) it demands the `test:contract` run actually executed real
// assertions rather than skipping the whole suite.
//
// On an unsupported local dev machine it is a deliberate no-op, matching the
// existing `describe.skip` behavior inside the contract test files - local
// development must stay unblocked; only Pact-capable platforms enforce the
// zero-verification guard strictly.
//
// The aggregate total/passed/pending counters above prove *some* contract
// test ran, but they cannot prove the *provider verification* suites in
// particular ran - a vitest config/glob regression that silently excluded
// `*-provider.test.ts` (e.g. a narrowed `include` pattern, or those files
// being accidentally moved out of `test/contract`) would still leave the
// aggregate counters looking healthy as long as the consumer specs passed.
// `REQUIRED_PROVIDER_VERIFICATION_FILES` closes that gap by asserting each
// named provider-verification suite is present in the report with at least
// one assertion, and that every assertion in it passed.
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

export interface ContractGateAssertionResult {
  readonly status?: string
}

export interface ContractGateFileResult {
  readonly name?: string
  readonly assertionResults?: ReadonlyArray<ContractGateAssertionResult>
}

export interface VitestJsonSummary {
  readonly numTotalTests?: number
  readonly numPassedTests?: number
  readonly numPendingTests?: number
  readonly numFailedTests?: number
  readonly testResults?: ReadonlyArray<ContractGateFileResult>
}

export interface ContractGatePlatform {
  readonly platform: string
  readonly arch: string
}

/**
 * Real, first-party provider-verification suites (audit item 1) that must
 * always be present and fully passing in a `test/contract` run on a
 * Pact-supported platform. Each of these boots the real `src/worker.ts` app
 * and runs Pact's `Verifier` against it - see the files themselves for
 * details. Keep this list in sync with `test/contract/*-provider.test.ts`.
 */
export const REQUIRED_PROVIDER_VERIFICATION_FILES: ReadonlyArray<string> = [
  'workflow-worker-provider.test.ts',
  'workflow-task-provider.test.ts',
]

export function isPactSupported({platform, arch}: ContractGatePlatform): boolean {
  return !(platform === 'win32' && arch === 'arm64')
}

/**
 * Validates a vitest JSON reporter summary for `test/contract`, enforcing
 * that the gate cannot silently pass with zero provider verifications. Also
 * checks that the specific provider-verification suites named in
 * `REQUIRED_PROVIDER_VERIFICATION_FILES` are present with fully passing,
 * non-empty assertions - proving those suites actually ran, not just that
 * some contract test somewhere passed.
 *
 * Returns a human-readable status message on success; throws on any
 * violation. On a platform without Pact support this is a deliberate no-op
 * (returns a skip message) so local development is never blocked.
 */
export function assertContractVerified(
  report: VitestJsonSummary,
  platform: ContractGatePlatform = {platform: process.platform, arch: process.arch},
): string {
  if (!isPactSupported(platform)) {
    return (
      '[assert-contract-verified] Pact is unsupported on this platform ' +
      '(win32/arm64); skipping the zero-verification guard. This check is ' +
      'only enforced on Pact-capable platforms such as CI.'
    )
  }

  const total = report.numTotalTests ?? 0
  const passed = report.numPassedTests ?? 0
  const pending = report.numPendingTests ?? 0
  const failed = report.numFailedTests ?? 0

  if (total === 0) {
    throw new Error(
      'No contract tests were discovered. The Pact quality gate must not pass with zero interactions verified.',
    )
  }

  if (passed === 0) {
    throw new Error(
      'Zero contract tests passed. The Pact quality gate must not silently pass with zero provider verifications.',
    )
  }

  if (pending > 0) {
    throw new Error(
      `${pending} of ${total} contract test(s) were skipped on a platform that claims Pact support ` +
        '(pactSupported evaluated true). Investigate before trusting this gate: a supported ' +
        'CI runner should never skip contract tests.',
    )
  }

  const fileResults = report.testResults ?? []
  for (const requiredFile of REQUIRED_PROVIDER_VERIFICATION_FILES) {
    const match = fileResults.find((file) =>
      (file.name ?? '').replaceAll('\\', '/').endsWith(`/${requiredFile}`),
    )
    if (!match) {
      throw new Error(
        `Required provider verification suite "${requiredFile}" did not appear in the contract ` +
          'test report. The gate must prove real provider verification ran on CI, not just that ' +
          'some other contract test passed - check for a vitest config/glob regression that ' +
          'excluded this file from test/contract.',
      )
    }
    const assertions = match.assertionResults ?? []
    if (assertions.length === 0) {
      throw new Error(
        `Required provider verification suite "${requiredFile}" reported zero assertions. ` +
          'The gate must not silently pass with zero provider verifications.',
      )
    }
    const notPassed = assertions.filter((assertion) => assertion.status !== 'passed')
    if (notPassed.length > 0) {
      throw new Error(
        `Required provider verification suite "${requiredFile}" has ${notPassed.length} ` +
          `assertion(s) that did not pass (status: ${notPassed
            .map((assertion) => assertion.status ?? 'unknown')
            .join(', ')}).`,
      )
    }
  }

  return (
    `[assert-contract-verified] ${passed}/${total} contract tests passed with zero skips and ` +
    `${failed} failures across ${fileResults.length} file(s), including all ` +
    `${REQUIRED_PROVIDER_VERIFICATION_FILES.length} required provider verification suite(s) - ` +
    'the gate verified real interactions.'
  )
}

async function main(): Promise<void> {
  const resultsPath = process.argv[2]
  if (!resultsPath) {
    throw new Error('Usage: tsx scripts/assert-contract-verified.ts <vitest-json-report-path>')
  }
  const report = JSON.parse(await readFile(resultsPath, 'utf8')) as VitestJsonSummary
  console.log(assertContractVerified(report))
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
