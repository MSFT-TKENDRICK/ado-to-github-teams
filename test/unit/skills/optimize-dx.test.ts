import {describe, expect, it} from 'vitest'
import {
  DEFAULT_DX_ITERATIONS,
  DX_AREA_CATALOG,
  parseCliArgs,
  resolveIterationCount,
  rotateAreas,
} from '../../../skills/optimize-dx/scripts/optimize-dx.js'

describe('optimize-dx iteration contract', () => {
  it('defaults each run to eight iterations and mirrors optimize-ux behaviour', () => {
    expect(DEFAULT_DX_ITERATIONS).toBe(8)
    expect(resolveIterationCount(undefined)).toBe(8)
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

  it('exposes an eleven-area catalog whose ids form the required DevEx surface', () => {
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
    ])
  })

  it('rotates through the real catalog including wraparound at the default eight passes', () => {
    const visited = rotateAreas(DEFAULT_DX_ITERATIONS, DX_AREA_CATALOG)
    expect(visited).toHaveLength(DEFAULT_DX_ITERATIONS)
    expect(visited[0]).toBe('documentation')
    // Eight iterations across an eleven-area catalog: partial coverage in the first pass.
    expect(visited[DEFAULT_DX_ITERATIONS - 1]).toBe(DX_AREA_CATALOG[DEFAULT_DX_ITERATIONS - 1]?.id)
    // Full catalog coverage: every area is visited when iterations === catalog length.
    const oneFullPass = rotateAreas(DX_AREA_CATALOG.length, DX_AREA_CATALOG)
    expect(oneFullPass).toEqual(DX_AREA_CATALOG.map((area) => area.id))
    expect(oneFullPass[DX_AREA_CATALOG.length - 1]).toBe('dotfiles')
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
