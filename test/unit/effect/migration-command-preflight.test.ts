import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  MigrationCommandPreflightLiveLayer,
  renderMigrationCommandCorrection,
  validateMigrationCommand,
  type MigrationCommandInput,
} from '../../../src/effect/migration-command-preflight.js'

const validInput: MigrationCommandInput = {
  adoOrg: 'https://dev.azure.com/contoso',
  adoProject: 'Core Platform',
  githubOrg: 'contoso',
  apply: false,
  detail: 'guided',
  yes: false,
  fresh: true,
  foreground: true,
  sessions: false,
  tui: true,
  concurrency: 4,
  workerUrl: 'http://127.0.0.1:7331',
  listSandboxScenarios: false,
}

function preflight(input: unknown) {
  return Effect.runSync(
    Effect.either(
      validateMigrationCommand(input).pipe(Effect.provide(MigrationCommandPreflightLiveLayer)),
    ),
  )
}

describe('migration command preflight', () => {
  it('accepts a complete dry-run command', () => {
    expect(preflight(validInput)).toEqual(Either.right(validInput))
  })

  it('rejects partial live scope before worker access with a corrected shape', () => {
    const result = preflight({...validInput, githubOrg: undefined})

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: 'MigrationCommandPreflightFailure',
        issue: 'incomplete-live-scope',
      })
      expect(result.left.correctedCommand).toContain('--github-org <org>')
      expect(result.left.correctedCommand).not.toContain('undefined')
    }
  })

  it('preserves resume and removes fresh from the corrected command', () => {
    const result = preflight({...validInput, fresh: true, resume: 'run-123'})

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.issue).toBe('fresh-resume-conflict')
      expect(result.left.correctedCommand).toContain('--resume run-123')
      expect(result.left.correctedCommand).not.toContain('--fresh')
    }
  })

  it('corrects sandbox mode and concurrency without provider access', () => {
    const missingApply = preflight({
      ...validInput,
      adoOrg: undefined,
      adoProject: undefined,
      githubOrg: undefined,
      fresh: false,
      sandbox: 'apply-happy-path',
      scenarioMode: 'apply',
    })
    const invalidConcurrency = preflight({...validInput, concurrency: 0})

    expect(Either.isLeft(missingApply)).toBe(true)
    expect(Either.isLeft(invalidConcurrency)).toBe(true)
    if (Either.isLeft(missingApply) && Either.isLeft(invalidConcurrency)) {
      expect(missingApply.left.correctedCommand).toBe(
        'ado-to-github-teams migrate --sandbox apply-happy-path --apply --foreground',
      )
      expect(invalidConcurrency.left.correctedCommand).toContain('--concurrency 1')
    }
  })

  it('renders values with spaces as one executable command argument', () => {
    expect(renderMigrationCommandCorrection(validInput)).toContain('--ado-project "Core Platform"')
  })

  it('preserves the line-oriented --no-tui preference in the corrected command', () => {
    expect(renderMigrationCommandCorrection(validInput)).not.toContain('--no-tui')
    expect(renderMigrationCommandCorrection({...validInput, tui: false})).toContain('--no-tui')

    const conflict = preflight({...validInput, tui: false, fresh: true, resume: 'run-9'})
    expect(Either.isLeft(conflict)).toBe(true)
    if (Either.isLeft(conflict)) {
      expect(conflict.left.correctedCommand).toContain('--no-tui')
    }
  })
})
