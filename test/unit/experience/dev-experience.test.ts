import {describe, expect, it} from 'vitest'
import {
  countPackageScripts,
  danglingTurboInputs,
  documentedScriptRatio,
  duplicateFormatConfigCount,
  hookEnforcementStatus,
  isTimingEnabled,
  PRETTIER_CONFIG_CANDIDATES,
} from '../../../src/experience/dev-experience.js'

describe('dev-experience pure measurements', () => {
  describe('countPackageScripts', () => {
    it('counts declared scripts', () => {
      expect(countPackageScripts({scripts: {build: 'x', test: 'y', lint: 'z'}})).toBe(3)
    })

    it('returns zero when scripts is missing or empty', () => {
      expect(countPackageScripts({})).toBe(0)
      expect(countPackageScripts({scripts: {}})).toBe(0)
    })
  })

  describe('documentedScriptRatio', () => {
    it('reports full coverage when every script is documented', () => {
      const result = documentedScriptRatio(['build', 'test'], ['build', 'test', 'legacy'])
      expect(result).toEqual({documented: 2, total: 2, ratio: 1})
    })

    it('reports partial coverage without counting undocumented scripts', () => {
      const result = documentedScriptRatio(['build', 'test', 'lint'], ['build'])
      expect(result).toEqual({documented: 1, total: 3, ratio: 1 / 3})
    })

    it('treats an empty script surface as fully documented', () => {
      expect(documentedScriptRatio([], [])).toEqual({documented: 0, total: 0, ratio: 1})
    })
  })

  describe('hookEnforcementStatus', () => {
    it('only reports enforced when both config and dependency are present', () => {
      expect(hookEnforcementStatus({hasLefthookConfig: true, hasLefthookDependency: true})).toBe(
        'enforced',
      )
    })

    it('flags config-without-dep as fail-open (installed hook has nothing to run)', () => {
      expect(hookEnforcementStatus({hasLefthookConfig: true, hasLefthookDependency: false})).toBe(
        'fail-open',
      )
    })

    it('flags dep-without-config as fail-open (nothing tells the binary what to enforce)', () => {
      expect(hookEnforcementStatus({hasLefthookConfig: false, hasLefthookDependency: true})).toBe(
        'fail-open',
      )
    })

    it('reports absent when nothing is present', () => {
      expect(hookEnforcementStatus({hasLefthookConfig: false, hasLefthookDependency: false})).toBe(
        'absent',
      )
    })
  })

  describe('duplicateFormatConfigCount', () => {
    it('returns 0 when no Prettier config is present', () => {
      expect(duplicateFormatConfigCount(['README.md', 'package.json'])).toBe(0)
    })

    it('returns 1 for a healthy repository with a single Prettier config', () => {
      expect(duplicateFormatConfigCount(['.prettierrc.json', 'package.json'])).toBe(1)
    })

    it('flags every duplicate Prettier config as extra surface', () => {
      const files = ['.prettierrc.json', 'prettier.config.mjs', 'README.md']
      expect(duplicateFormatConfigCount(files)).toBe(2)
    })

    it('enumerates every well-known Prettier resolver entry', () => {
      expect(PRETTIER_CONFIG_CANDIDATES).toContain('.prettierrc.json')
      expect(PRETTIER_CONFIG_CANDIDATES).toContain('prettier.config.mjs')
      expect(PRETTIER_CONFIG_CANDIDATES).toContain('.prettierrc')
    })
  })

  describe('danglingTurboInputs', () => {
    const existing = (paths: readonly string[]) => (path: string) =>
      new Set<string>(paths).has(path)

    it('returns empty when every input resolves', () => {
      const findings = danglingTurboInputs(
        {tasks: {build: {inputs: ['$TURBO_DEFAULT$', 'tsconfig.base.json']}}},
        existing(['tsconfig.base.json']),
      )
      expect(findings).toEqual([])
    })

    it('flags inputs that do not resolve on disk', () => {
      const findings = danglingTurboInputs(
        {
          tasks: {
            lint: {
              inputs: ['$TURBO_DEFAULT$', '../../eslint.config.mjs', '../../tsconfig.base.json'],
            },
          },
        },
        existing(['tsconfig.base.json']),
      )
      expect(findings).toEqual([
        {task: 'lint', input: '../../eslint.config.mjs'},
        {task: 'lint', input: '../../tsconfig.base.json'},
      ])
    })

    it('handles tasks with no inputs field', () => {
      const findings = danglingTurboInputs({tasks: {'test:contract': {}}}, existing([]))
      expect(findings).toEqual([])
    })

    it('never treats $TURBO_DEFAULT$ as a path', () => {
      const findings = danglingTurboInputs(
        {tasks: {build: {inputs: ['$TURBO_DEFAULT$']}}},
        existing([]),
      )
      expect(findings).toEqual([])
    })
  })

  describe('isTimingEnabled', () => {
    it('requires exact "1" to opt in', () => {
      expect(isTimingEnabled({DX_MEASURE_TIMING: '1'})).toBe(true)
      expect(isTimingEnabled({DX_MEASURE_TIMING: 'true'})).toBe(false)
      expect(isTimingEnabled({DX_MEASURE_TIMING: ''})).toBe(false)
      expect(isTimingEnabled({})).toBe(false)
    })
  })
})
