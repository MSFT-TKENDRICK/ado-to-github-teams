import {describe, expect, it} from 'vitest'
import {
  DEFAULT_DX_ITERATIONS,
  DX_AREA_CATALOG,
  classifyDxAreaOutcome,
  parseCliArgs,
  resolveIterationCount,
  rotateAreas,
} from '../../../skills/optimize-dx/scripts/optimize-dx.js'

describe('optimize-dx iteration contract', () => {
  it('defaults each run to one complete fifteen-area traversal', () => {
    expect(DEFAULT_DX_ITERATIONS).toBe(15)
    expect(resolveIterationCount(undefined)).toBe(15)
    expect(resolveIterationCount('5')).toBe(5)
  })

  it('rejects out-of-range integers with a range-shaped error', () => {
    expect(() => resolveIterationCount('0')).toThrow(/1 through 20/)
    expect(() => resolveIterationCount('-1')).toThrow(/1 through 20/)
    expect(() => resolveIterationCount('21')).toThrow(/1 through 20/)
  })

  it('rejects non-integers and non-numerics with an integer-shaped error', () => {
    expect(() => resolveIterationCount('2.5')).toThrow(/integer/)
    expect(() => resolveIterationCount('abc')).toThrow(/integer/)
  })

  it('rotates through the injected catalog in list order and wraps at the end', () => {
    const catalog = [{id: 'a'}, {id: 'b'}, {id: 'c'}] as const
    expect(rotateAreas(0, catalog)).toEqual([])
    expect(rotateAreas(2, catalog)).toEqual(['a', 'b'])
    expect(rotateAreas(3, catalog)).toEqual(['a', 'b', 'c'])
    expect(rotateAreas(5, catalog)).toEqual(['a', 'b', 'c', 'a', 'b'])
    expect(rotateAreas(8, catalog)).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b'])
    expect(rotateAreas(3, [])).toEqual([])
  })

  it('exposes a fifteen-area catalog covering contributor and shipped-consumer surfaces', () => {
    const ids = DX_AREA_CATALOG.map((area) => area.id)
    expect(ids).toEqual([
      'documentation',
      'repository-structure-and-config',
      'local-environment-and-onboarding',
      'file-folder-hierarchy',
      'projects-and-workspaces',
      'packages-and-dependencies',
      'developer-tools',
      'git-hooks',
      'git-github-cli-and-extensions',
      'devcontainers',
      'dotfiles',
      'cli-invocation-and-naming',
      'packaging-and-distribution',
      'release-and-versioning',
      'build-package-and-deploy',
    ])
  })

  it('marks every shipped-consumer area with executable evidence outside the rotation', () => {
    for (const id of [
      'cli-invocation-and-naming',
      'packaging-and-distribution',
      'release-and-versioning',
      'build-package-and-deploy',
    ]) {
      const area = DX_AREA_CATALOG.find((candidate) => candidate.id === id)
      expect(area?.requiredEvidence, `${id} must name its executable evidence`).toBeTruthy()
    }
  })

  it('requires registry-backed two-command evidence for packaging and distribution', () => {
    const packaging = DX_AREA_CATALOG.find(({id}) => id === 'packaging-and-distribution')
    expect(packaging?.requiredEvidence).toContain('@msft-tkendrick/a2g@preview')
    expect(packaging?.requiredEvidence).toContain('post-publish clean install')
    expect(packaging?.expectedObservation).toContain('one consumer command')
    expect(packaging?.expectedObservation).toContain('one verification command')
  })

  it('fails shipped-surface areas closed until their executable evidence is recorded', () => {
    const packaging = DX_AREA_CATALOG.find(({id}) => id === 'packaging-and-distribution')
    expect(packaging).toBeDefined()

    expect(
      classifyDxAreaOutcome(packaging!, {
        scriptCount: 0,
        documentedRatio: {documented: 0, total: 0, ratio: 0},
        hookStatus: 'absent',
        prettierConfigCount: 0,
        danglingTurbo: [],
        onboardingStatus: 'friction',
      }),
    ).toEqual({
      desirability: 'undesirable',
      degree: 0,
      delta: expect.stringContaining('acceptance is blocked'),
    })
  })

  it('makes the primary contributor on-ramp falsifiable', () => {
    const onboarding = DX_AREA_CATALOG.find(({id}) => id === 'local-environment-and-onboarding')
    expect(onboarding).toBeDefined()
    const baseSnapshot = {
      scriptCount: 33,
      documentedRatio: {documented: 33, total: 33, ratio: 1},
      hookStatus: 'enforced' as const,
      prettierConfigCount: 1,
      danglingTurbo: [],
    }

    expect(
      classifyDxAreaOutcome(onboarding!, {...baseSnapshot, onboardingStatus: 'streamlined'}),
    ).toMatchObject({desirability: 'desirable', degree: 1})
    expect(
      classifyDxAreaOutcome(onboarding!, {...baseSnapshot, onboardingStatus: 'friction'}),
    ).toMatchObject({desirability: 'undesirable', degree: 0})
  })

  it('visits every real catalog area in the default run and then wraps', () => {
    const visited = rotateAreas(DEFAULT_DX_ITERATIONS, DX_AREA_CATALOG)
    expect(visited).toHaveLength(DEFAULT_DX_ITERATIONS)
    expect(visited[0]).toBe('documentation')
    expect(DEFAULT_DX_ITERATIONS).toBe(DX_AREA_CATALOG.length)
    expect(visited).toEqual(DX_AREA_CATALOG.map((area) => area.id))
    const oneFullPass = rotateAreas(DX_AREA_CATALOG.length, DX_AREA_CATALOG)
    expect(oneFullPass).toEqual(DX_AREA_CATALOG.map((area) => area.id))
    expect(oneFullPass[DX_AREA_CATALOG.length - 1]).toBe('build-package-and-deploy')
    // Larger than catalog length: wraps back to `documentation`.
    const wrapped = rotateAreas(DX_AREA_CATALOG.length + 3, DX_AREA_CATALOG)
    expect(wrapped[DX_AREA_CATALOG.length]).toBe('documentation')
    expect(wrapped[DX_AREA_CATALOG.length + 1]).toBe('repository-structure-and-config')
    expect(wrapped[DX_AREA_CATALOG.length + 2]).toBe('local-environment-and-onboarding')
  })
})

describe('optimize-dx CLI parser', () => {
  it('accepts a bare invocation and returns the default iteration count', () => {
    expect(parseCliArgs([])).toEqual({iterations: DEFAULT_DX_ITERATIONS})
  })

  it('accepts --iterations <n> and --iterations=<n>', () => {
    expect(parseCliArgs(['--iterations', '4'])).toEqual({iterations: 4})
    expect(parseCliArgs(['--iterations=6'])).toEqual({iterations: 6})
  })

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(/Unknown option/)
  })

  it('surfaces a help sentinel for --help and -h', () => {
    expect(() => parseCliArgs(['--help'])).toThrow(/__HELP__/)
    expect(() => parseCliArgs(['-h'])).toThrow(/__HELP__/)
  })
})
