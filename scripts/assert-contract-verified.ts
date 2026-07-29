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
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

export interface VitestJsonSummary {
  readonly numTotalTests?: number
  readonly numPassedTests?: number
  readonly numPendingTests?: number
  readonly numFailedTests?: number
}

export interface ContractGatePlatform {
  readonly platform: string
  readonly arch: string
}

export function isPactSupported({platform, arch}: ContractGatePlatform): boolean {
  return !(platform === 'win32' && arch === 'arm64')
}

/**
 * Validates a vitest JSON reporter summary for `test/contract`, enforcing
 * that the gate cannot silently pass with zero provider verifications.
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

  return (
    `[assert-contract-verified] ${passed}/${total} contract tests passed with zero skips and ` +
    `${failed} failures - the gate verified real interactions.`
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
