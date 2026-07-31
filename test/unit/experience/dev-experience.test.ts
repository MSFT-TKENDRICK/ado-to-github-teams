import {describe, expect, it} from 'vitest'
import {
  countPackageScripts,
  danglingTurboInputs,
  DEVEX_JOURNEYS,
  documentedScriptRatio,
  duplicateFormatConfigCount,
  extractPnpmScriptReferences,
  hookEnforcementStatus,
  isTimingEnabled,
  PRETTIER_CONFIG_CANDIDATES,
} from '../../../src/experience/dev-experience.js'
import {
  DEVELOPER_PERSONA_IDS,
  OPERATOR_PERSONA_IDS,
  PERSONA_DEFINITIONS,
} from '../../../src/experience/personas.js'
import {CLI_JOURNEYS} from '../../../src/experience/cli-journeys.js'

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

    describe('extractPnpmScriptReferences', () => {
      it('extracts deduplicated script names from commands with flags and arguments', () => {
        expect(
          extractPnpmScriptReferences([
            'Run `pnpm optimize:dx -- --iterations 3` and `pnpm test:unit`.',
            'Repeat `pnpm test:unit -- path/to/test.ts`.',
          ]),
        ).toEqual(['optimize:dx', 'test:unit'])
      })
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

describe('developer-experience persona and journey isolation', () => {
  it('has exactly one developer-domain persona and it is the contributor engineer', () => {
    const developers = PERSONA_DEFINITIONS.filter((persona) => persona.domain === 'developer')
    expect(developers).toHaveLength(1)
    expect(developers[0]?.id).toBe('cli-contributor-engineer')
    expect(DEVELOPER_PERSONA_IDS).toEqual(['cli-contributor-engineer'])
  })

  it('has ten operator-domain personas and does not include the contributor', () => {
    expect(OPERATOR_PERSONA_IDS).toHaveLength(10)
    expect(OPERATOR_PERSONA_IDS).not.toContain('cli-contributor-engineer')
  })

  it('binds every DEVEX_JOURNEYS entry to the contributor persona and only that persona', () => {
    // Structural belt-and-suspenders check: the Schema literal already prevents any other id, but
    // this assertion protects against a future widening of the schema without the intent behind it.
    expect(DEVEX_JOURNEYS.length).toBeGreaterThan(0)
    for (const journey of DEVEX_JOURNEYS) {
      expect(journey.persona).toBe('cli-contributor-engineer')
    }
  })

  it('never re-couples the contributor persona to operator CLI journeys', () => {
    for (const journey of CLI_JOURNEYS) {
      expect(
        journey.personas,
        `operator journey ${journey.id} must not include cli-contributor-engineer`,
      ).not.toContain('cli-contributor-engineer')
    }
  })

  it('gives every DEVEX_JOURNEYS entry a non-empty title, touchpoint, and measurement', () => {
    for (const journey of DEVEX_JOURNEYS) {
      expect(journey.title.length).toBeGreaterThan(0)
      expect(journey.touchpoint.length).toBeGreaterThan(0)
      expect(journey.measurement.length).toBeGreaterThan(0)
    }
  })

  it('requires executable evidence for the complete ship-and-consume CLI journey', () => {
    const journey = DEVEX_JOURNEYS.find(({id}) => id === 'ship-and-consume-cli')
    expect(journey).toBeDefined()
    expect(journey?.steps).toHaveLength(7)
    expect(journey?.evidence).toEqual(
      expect.arrayContaining([
        'pnpm package:smoke',
        '.github/workflows/release.yml post-publish clean consumer install',
        expect.stringContaining('version-policy.test.ts'),
        'pnpm azure:build (Ubuntu x64 CI)',
      ]),
    )
    expect(journey?.measurement.toLowerCase()).toContain(
      'documentation-only and source-fallback evidence is rejected',
    )
    expect(journey?.steps?.[0]).toContain(
      'exactly one install command and one verification command',
    )
    expect(journey?.touchpoint).toContain('@msft-tkendrick/a2g')
    expect(journey?.touchpoint).toContain('a2g')
  })
})
