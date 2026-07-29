import {describe, expect, it} from 'vitest'
import {
  assertContractVerified,
  isPactSupported,
  REQUIRED_PROVIDER_VERIFICATION_FILES,
  type ContractGateFileResult,
  type VitestJsonSummary,
} from '../../../scripts/assert-contract-verified.js'

const linuxCi = {platform: 'linux', arch: 'x64'} as const
const windowsArm = {platform: 'win32', arch: 'arm64'} as const

/** A passing file result for every required provider-verification suite, plus one consumer file. */
function passingFileResults(): ContractGateFileResult[] {
  return [
    ...REQUIRED_PROVIDER_VERIFICATION_FILES.map((name) => ({
      name: `/repo/test/contract/${name}`,
      assertionResults: [{status: 'passed'}],
    })),
    {name: '/repo/test/contract/github-consumer.test.ts', assertionResults: [{status: 'passed'}]},
  ]
}

describe('isPactSupported', () => {
  it('reports Pact as unsupported on win32/arm64', () => {
    expect(isPactSupported(windowsArm)).toBe(false)
  })

  it('reports Pact as supported on the CI runner platform', () => {
    expect(isPactSupported(linuxCi)).toBe(true)
  })

  it('reports Pact as supported on other win32 architectures', () => {
    expect(isPactSupported({platform: 'win32', arch: 'x64'})).toBe(true)
  })
})

describe('assertContractVerified', () => {
  it('throws when zero contract tests were discovered on a supported platform', () => {
    const report: VitestJsonSummary = {numTotalTests: 0, numPassedTests: 0, numPendingTests: 0}
    expect(() => assertContractVerified(report, linuxCi)).toThrow(/zero interactions verified/)
  })

  it('throws when every contract test was skipped on a supported platform', () => {
    const report: VitestJsonSummary = {numTotalTests: 32, numPassedTests: 0, numPendingTests: 32}
    expect(() => assertContractVerified(report, linuxCi)).toThrow(
      /must not silently pass with zero provider verifications/,
    )
  })

  it('throws when any contract test is pending on a supported platform, even if others passed', () => {
    const report: VitestJsonSummary = {numTotalTests: 32, numPassedTests: 30, numPendingTests: 2}
    expect(() => assertContractVerified(report, linuxCi)).toThrow(
      /should never skip contract tests/,
    )
  })

  it('succeeds when every contract test passed with zero skips on a supported platform', () => {
    const report: VitestJsonSummary = {
      numTotalTests: 32,
      numPassedTests: 32,
      numPendingTests: 0,
      numFailedTests: 0,
      testResults: passingFileResults(),
    }
    expect(assertContractVerified(report, linuxCi)).toMatch(/32\/32 contract tests passed/)
  })

  it('does not block local development on an unsupported platform, even with zero passes', () => {
    const report: VitestJsonSummary = {numTotalTests: 32, numPassedTests: 0, numPendingTests: 32}
    expect(assertContractVerified(report, windowsArm)).toMatch(
      /skipping the zero-verification guard/,
    )
  })

  it('throws when a required provider verification suite is missing from the report entirely', () => {
    const report: VitestJsonSummary = {
      numTotalTests: 32,
      numPassedTests: 32,
      numPendingTests: 0,
      numFailedTests: 0,
      // Only the consumer file is present - as if a vitest glob change
      // silently dropped the provider-verification suites from the run.
      testResults: [
        {
          name: '/repo/test/contract/github-consumer.test.ts',
          assertionResults: [{status: 'passed'}],
        },
      ],
    }
    expect(() => assertContractVerified(report, linuxCi)).toThrow(
      /did not appear in the contract test report/,
    )
  })

  it('throws when a required provider verification suite reported zero assertions', () => {
    const [firstRequired, ...rest] = REQUIRED_PROVIDER_VERIFICATION_FILES
    const report: VitestJsonSummary = {
      numTotalTests: 32,
      numPassedTests: 32,
      numPendingTests: 0,
      numFailedTests: 0,
      testResults: [
        {name: `/repo/test/contract/${firstRequired}`, assertionResults: []},
        ...rest.map((name) => ({
          name: `/repo/test/contract/${name}`,
          assertionResults: [{status: 'passed'}],
        })),
      ],
    }
    expect(() => assertContractVerified(report, linuxCi)).toThrow(/reported zero assertions/)
  })

  it('throws when a required provider verification suite has a non-passing assertion', () => {
    const [firstRequired, ...rest] = REQUIRED_PROVIDER_VERIFICATION_FILES
    const report: VitestJsonSummary = {
      numTotalTests: 32,
      numPassedTests: 31,
      numPendingTests: 0,
      numFailedTests: 1,
      testResults: [
        {name: `/repo/test/contract/${firstRequired}`, assertionResults: [{status: 'failed'}]},
        ...rest.map((name) => ({
          name: `/repo/test/contract/${name}`,
          assertionResults: [{status: 'passed'}],
        })),
      ],
    }
    expect(() => assertContractVerified(report, linuxCi)).toThrow(/did not pass/)
  })
})
