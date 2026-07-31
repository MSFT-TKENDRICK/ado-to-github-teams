import {describe, expect, it} from 'vitest'
import {
  MigrationCommandPreflightFailure,
  PermissionFailure,
  TransientFailure,
} from '../../../src/effect/errors.js'
import {WorkflowWorkerFailure} from '../../../src/workflow/client.js'
import {recoveryGuidance, renderRecoveryGuidance} from '../../../src/ui/recovery-guidance.js'

describe('recovery guidance', () => {
  it('explains checkpoint-safe recovery for an apply failure', () => {
    const output = renderRecoveryGuidance(
      new TransientFailure({
        service: 'github',
        message: 'GitHub asked the client to retry later',
        status: 429,
        retryAfterMs: 1_000,
      }),
      ['migrate', '--apply'],
    )

    expect(output).toContain('Migration could not continue.')
    expect(output).toContain('Do not start with --fresh')
    expect(output).toContain('Wait for the provider retry interval')
    expect(output).toContain('completed writes will be reconciled')
    expect(output).toContain('TransientFailure | HTTP 429')
  })

  it('provides SSO remediation without suggesting a fresh migration', () => {
    const guidance = recoveryGuidance(
      new PermissionFailure({
        service: 'github',
        message: 'SAML SSO authorization is required',
        status: 403,
        ssoRequired: true,
      }),
      ['migrate', '--apply'],
    )

    expect(guidance.nextSteps[0]).toContain('SAML SSO')
    expect(guidance.nextSteps[1]).toContain('do not use --fresh')
  })

  it('distinguishes worker authentication from worker availability', () => {
    const authentication = recoveryGuidance(
      new WorkflowWorkerFailure({message: 'Unauthorized', status: 401}),
      ['migrate'],
    )
    const availability = recoveryGuidance(
      new WorkflowWorkerFailure({message: 'Connection refused'}),
      ['migrate'],
    )

    expect(authentication.nextSteps[0]).toContain('WORKFLOW_API_TOKEN')
    expect(availability.nextSteps[0]).toContain('--worker-url')
  })

  it('states that sandbox writes are simulated', () => {
    const guidance = recoveryGuidance(new Error('Fixture exhausted'), [
      'migrate',
      '--sandbox=happy-path',
    ])

    expect(guidance.state).toContain('provider writes are simulated')
  })

  it('routes unknown commands back to task help and valid examples', () => {
    const guidance = recoveryGuidance(new Error('command frobnicate not found'), ['frobnicate'])

    expect(guidance.nextSteps).toEqual([
      'Run `a2g --help` to choose a command by operator task.',
      'Preview safely with `a2g migrate --ado-org <url> --ado-project <project> --github-org <org> --foreground`.',
      'Reopen the latest durable migration with `a2g` (no arguments).',
    ])
  })

  it('surfaces the corrected command after preflight rejects input', () => {
    const guidance = recoveryGuidance(
      new MigrationCommandPreflightFailure({
        issue: 'fresh-resume-conflict',
        message: '--fresh cannot be combined with --resume.',
        correctedCommand: 'a2g migrate --resume run-123',
      }),
      ['migrate', '--fresh', '--resume', 'run-123'],
    )

    expect(guidance.nextSteps).toEqual([
      'No provider or worker access occurred because command preflight failed.',
      'Run the corrected shape: `a2g migrate --resume run-123`.',
    ])
  })
})
