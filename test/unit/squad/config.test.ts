import {describe, expect, it} from 'vitest'
import squadConfig, {
  INFRASTRUCTURE_AGENT_NAMES,
  PERSONA_AGENT_NAMES,
  PERSONA_SQUAD_PROFILES,
} from '../../../squad.config.ts'
import {PERSONAS} from '../../../src/experience/persona-experiment.js'
import {stripSquadUnionMergeAttributes} from '../../../scripts/squad-gitattributes.js'

describe('SDK-first Squad configuration', () => {
  it('promotes every experiment persona into one active Squad agent', () => {
    const expectedNames = PERSONAS.map((persona) => persona.name.toLowerCase())
    const personaAgents = squadConfig.agents.filter((agent) =>
      PERSONA_AGENT_NAMES.includes(agent.name),
    )

    expect(PERSONA_AGENT_NAMES).toEqual(expectedNames)
    expect(personaAgents.map((agent) => agent.name)).toEqual(expectedNames)
    expect(personaAgents).toHaveLength(PERSONAS.length)
    expect(
      personaAgents.every(
        (agent) =>
          agent.status === 'active' &&
          agent.capabilities !== undefined &&
          agent.capabilities.length >= 3 &&
          agent.charter?.includes('evidence-based operator lens'),
      ),
    ).toBe(true)
    expect(Object.keys(PERSONA_SQUAD_PROFILES).sort()).toEqual(
      PERSONAS.map((persona) => persona.id).sort(),
    )
  })

  it('keeps governance infrastructure explicit and routes every persona', () => {
    const agentNames = squadConfig.agents.map((agent) => agent.name)
    const routedAgents = new Set(
      squadConfig.routing?.rules.flatMap((rule) =>
        rule.agents.map((agent) => agent.replace(/^@/, '')),
      ),
    )

    expect(agentNames).toEqual([...PERSONA_AGENT_NAMES, ...INFRASTRUCTURE_AGENT_NAMES])
    expect(squadConfig.team.members).toEqual(agentNames.map((name) => `@${name}`))
    expect(PERSONA_AGENT_NAMES.every((name) => routedAgents.has(name))).toBe(true)
    expect(squadConfig.routing?.fallback).toBe('coordinator')
  })

  it('enables the relevant governance, ceremony, skill, and budget surfaces', () => {
    expect(squadConfig.hooks).toMatchObject({
      scrubPii: true,
      reviewerLockout: true,
      maxAskUser: 5,
    })
    expect(squadConfig.hooks?.blockedCommands).toEqual(
      expect.arrayContaining(['git reset --hard', 'git push --force']),
    )
    expect(squadConfig.defaults?.budget).toMatchObject({
      perAgentSpawn: 18_000,
      perSession: 120_000,
      warnAt: 0.8,
    })
    expect(squadConfig.ceremonies?.map((ceremony) => ceremony.name)).toEqual([
      'Migration design review',
      'Persona evidence review',
      'Pre-ship safety review',
      'Failure retrospective',
    ])
    expect(squadConfig.skills?.map((skill) => skill.name)).toEqual([
      'migration-safety-invariants',
      'persona-evidence-loop',
      'effect-architecture-boundaries',
    ])
    expect(squadConfig.telemetry).toBeUndefined()
  })
})

describe('Squad local-state bootstrap', () => {
  it('removes only the generated union-merge block and remains idempotent', () => {
    const generatedAttributes = [
      '*.png binary',
      '# Squad: union merge for append-only team state files',
      '.squad/decisions.md merge=union',
      '.squad/agents/*/history.md merge=union',
      '.squad/log/** merge=union',
      '.squad/orchestration-log/** merge=union',
      '.squad/rai/audit-trail.md merge=union',
      '.squad/fact-checker/audit-trail.md merge=union',
      'docs/** linguist-documentation',
      '',
    ].join('\n')
    const expectedAttributes = ['*.png binary', 'docs/** linguist-documentation', ''].join('\n')

    const cleaned = stripSquadUnionMergeAttributes(generatedAttributes)

    expect(cleaned).toBe(expectedAttributes)
    expect(stripSquadUnionMergeAttributes(cleaned)).toBe(expectedAttributes)
  })

  it('rejects a generated marker with an unexpected block', () => {
    expect(() =>
      stripSquadUnionMergeAttributes(
        [
          '*.png binary',
          '# Squad: union merge for append-only team state files',
          'custom merge=ours',
        ].join('\n'),
      ),
    ).toThrow('Refusing to remove an unexpected Squad merge-attribute block.')
  })
})
