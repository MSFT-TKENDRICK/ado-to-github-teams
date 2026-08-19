import {describe} from 'vitest'

import {isPactSupported} from '../../../scripts/assert-contract-verified.js'

/**
 * Single place that decides whether the Pact FFI can run on this machine — and, crucially, SAYS SO
 * when it cannot.
 *
 * Every `test/contract` spec previously repeated `describe.skip` behind an inline platform check.
 * That was correct but silent: on an unsupported machine a developer saw only `6 skipped` with no
 * explanation, which reads exactly like "this repository has no contract tests". It does. They are
 * real Pact consumer specs plus two genuine bi-directional provider verifications, and CI enforces
 * them on every push.
 *
 * `isPactSupported` is imported rather than re-derived so this module and the
 * `scripts/assert-contract-verified.ts` CI gate can never drift apart.
 */
export const pactSupported = isPactSupported({
  platform: process.platform,
  arch: process.arch,
})

/**
 * Why the skip happens, and the exact way to get a real local run.
 *
 * `@pact-foundation/pact-core` ships prebuilt native binaries for `darwin-arm64`, `darwin-x64`,
 * `linux-arm64`, `linux-x64` and `win32-x64` — there is no `win32-arm64` build, so an arm64 Node
 * process on Windows cannot load the FFI at all.
 *
 * The constraint is the *Node process* architecture, not the machine: Windows on ARM runs x64
 * binaries under emulation, and an x64 Node on the same machine loads the `win32-x64` prebuild and
 * runs the full suite. `pnpm.supportedArchitectures` in `package.json` installs the matching x64
 * esbuild/rollup binaries so vitest itself can also start under that Node.
 */
export const PACT_SKIP_GUIDANCE = [
  '',
  '  ┌─────────────────────────────────────────────────────────────────────────────┐',
  '  │ Pact contract tests were SKIPPED on this machine.                           │',
  '  └─────────────────────────────────────────────────────────────────────────────┘',
  `  Detected: ${process.platform}/${process.arch} on Node ${process.version}.`,
  '',
  '  These specs are real and they are enforced. CI (ubuntu-24.04) runs them on every',
  '  push, and scripts/assert-contract-verified.ts fails the build there if any spec is',
  '  skipped or if either provider-verification suite goes missing. A skip here is a',
  '  local platform limitation only - it is not a gap in the suite.',
  '',
  '  Cause: @pact-foundation/pact-core publishes no win32-arm64 native binary. The limit',
  '  is the Node process architecture, not the hardware.',
  '',
  '  To run them for real on Windows ARM, use an x64 Node. Windows executes it under',
  '  emulation and the win32-x64 Pact prebuild loads. vitest additionally needs its own',
  '  x64 esbuild/rollup binaries, so install those first:',
  '',
  '    pnpm install --config.supportedArchitectures.os[]=win32 \\',
  '                 --config.supportedArchitectures.cpu[]=x64',
  '',
  '  then run `pnpm test:contract` with an x64 Node on PATH.',
  '',
  '  Set A2G_SUPPRESS_PACT_SKIP_NOTICE=1 to silence this notice.',
  '',
].join('\n')

if (!pactSupported && process.env.A2G_SUPPRESS_PACT_SKIP_NOTICE !== '1') {
  console.warn(PACT_SKIP_GUIDANCE)
}

/**
 * Minimal structural type covering exactly what contract suites call: `contractDescribe(name, fn)`
 * and `contractDescribe.sequential(name, fn)`.
 *
 * Deliberately not `typeof describe`. Under pnpm's content-addressed layout TypeScript cannot name
 * vitest's internal `SuiteCollectorCallable`/`TestEachFunction` from a re-export and emits
 * TS2742/TS4023, and `describe.skip` is a narrower `ChainableSuiteAPI` that lacks `skipIf`/`runIf`,
 * so the full `SuiteAPI` type does not fit either. Describing only the surface actually used keeps
 * the declaration portable and the contract honest.
 */
type ContractSuite = ((name: string, factory: () => void) => void) & {
  readonly sequential: (name: string, factory: () => void) => void
}

/** `describe` for contract suites whose interactions are order-independent. */
export const contractDescribe: ContractSuite = pactSupported ? describe : describe.skip

/**
 * `describe.sequential` for consumer suites that drive a single Pact mock server. Parallel
 * interaction registration against one mock server races, so those suites must stay sequential.
 */
export const contractDescribeSequential: ContractSuite = pactSupported
  ? describe.sequential
  : describe.skip
