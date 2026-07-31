import {describe, expect, it} from 'vitest'
import squadConfig, {
  INFRASTRUCTURE_AGENT_NAMES,
  PERSONA_AGENT_NAMES,
  PERSONA_SQUAD_PROFILES,
} from '../../../squad.config.ts'
import {PERSONAS} from '../../../src/experience/persona-experiment.js'
import {
  DEVELOPER_PERSONA_IDS,
  OPERATOR_PERSONA_IDS,
  PERSONA_DEFINITIONS,
} from '../../../src/experience/personas.js'
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
    // Charter text distinguishes operator personas (evidence-based operator lens) from the
    // contributor persona (evidence-based contributor lens). We assert per-agent so a domain
    // regression flips the right test.
    for (const agent of personaAgents) {
      const persona = PERSONAS.find((entry) => entry.name.toLowerCase() === agent.name)
      expect(persona, `no persona backs agent ${agent.name}`).toBeDefined()
      expect(agent.status).toBe('active')
      expect(agent.capabilities?.length ?? 0).toBeGreaterThanOrEqual(3)
      if (persona?.domain === 'developer') {
        expect(agent.charter).toContain('evidence-based contributor lens')
        expect(agent.charter).not.toContain('evidence-based operator lens')
      } else {
        expect(agent.charter).toContain('evidence-based operator lens')
        expect(agent.charter).not.toContain('evidence-based contributor lens')
      }
    }
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
      'DevEx evidence review',
      'Pre-ship safety review',
      'Failure retrospective',
    ])
    expect(squadConfig.skills?.map((skill) => skill.name)).toEqual([
      'migration-safety-invariants',
      'persona-evidence-loop',
      'effect-architecture-boundaries',
      'optimize-dx',
    ])
    expect(squadConfig.telemetry).toBeUndefined()
  })
})

describe('SDK-agent participation drift', () => {
  // These assertions catch the case where a persona is added to the operator or developer
  // participation set (OPERATOR_PERSONA_IDS / DEVELOPER_PERSONA_IDS in src/experience/personas.ts)
  // but never gets promoted into a real Squad agent — or the reverse, where an agent's persona id
  // is silently renamed. Every persona participating in optimize-ux (operator) or optimize-dx
  // (developer) MUST correspond to a real generated Squad agent, or the persona is a phantom.
  it('maps every OPERATOR_PERSONA_ID 1:1 to an active Squad agent by lowercased persona name', () => {
    const agentNames = new Set(squadConfig.agents.map((agent) => agent.name))
    for (const personaId of OPERATOR_PERSONA_IDS) {
      const persona = PERSONA_DEFINITIONS.find((entry) => entry.id === personaId)
      expect(
        persona,
        `operator persona id ${personaId} is not defined in PERSONA_DEFINITIONS`,
      ).toBeDefined()
      if (persona) {
        const agentName = persona.name.toLowerCase()
        expect(
          agentNames.has(agentName),
          `operator persona ${personaId} (${persona.name}) has no active Squad agent named "${agentName}"`,
        ).toBe(true)
      }
    }
  })

  it('maps every DEVELOPER_PERSONA_ID 1:1 to an active Squad agent by lowercased persona name', () => {
    const agentNames = new Set(squadConfig.agents.map((agent) => agent.name))
    // Currently only cli-contributor-engineer (Theo) participates in optimize-dx, but this
    // assertion generalises so any future developer persona addition is caught immediately.
    expect(DEVELOPER_PERSONA_IDS.length).toBeGreaterThan(0)
    for (const personaId of DEVELOPER_PERSONA_IDS) {
      const persona = PERSONA_DEFINITIONS.find((entry) => entry.id === personaId)
      expect(
        persona,
        `developer persona id ${personaId} is not defined in PERSONA_DEFINITIONS`,
      ).toBeDefined()
      if (persona) {
        const agentName = persona.name.toLowerCase()
        expect(
          agentNames.has(agentName),
          `developer persona ${personaId} (${persona.name}) has no active Squad agent named "${agentName}"`,
        ).toBe(true)
      }
    }
  })

  it('does not require infrastructure agents to embody a persona (reverse mapping is intentionally not enforced)', () => {
    // Infrastructure agents (scribe, ralph, rai, fact-checker) exist to support governance and
    // memory, not to embody a research persona. They must NOT appear in either persona id list.
    const infraSet = new Set<string>(INFRASTRUCTURE_AGENT_NAMES)
    const combinedPersonaIds = new Set<string>([...OPERATOR_PERSONA_IDS, ...DEVELOPER_PERSONA_IDS])
    for (const infrastructureAgent of infraSet) {
      // Infra agent names are lowercased identifiers, not lowercased persona names, so we just
      // ensure the name isn't accidentally treated as a persona id.
      expect(combinedPersonaIds.has(infrastructureAgent)).toBe(false)
    }
    // And every persona agent is one of the persona-derived names, i.e. persona agents and
    // infrastructure agents partition the Squad roster with no overlap.
    for (const agent of squadConfig.agents) {
      if (infraSet.has(agent.name)) {
        continue
      }
      const backingPersona = PERSONA_DEFINITIONS.find(
        (entry) => entry.name.toLowerCase() === agent.name,
      )
      expect(
        backingPersona,
        `non-infrastructure agent ${agent.name} has no backing persona in PERSONA_DEFINITIONS`,
      ).toBeDefined()
    }
  })
})

interface RoutingRule {
  readonly pattern: string
  readonly agents: ReadonlyArray<string>
  readonly priority: number
  readonly description?: string
}

function tokensFor(pattern: string): ReadonlyArray<string> {
  return pattern
    .split('|')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/\*/g, '').toLowerCase())
}

function matchesPattern(pattern: string, phrase: string): boolean {
  const normalized = phrase.toLowerCase()
  return tokensFor(pattern).some((token) => token.length > 0 && normalized.includes(token))
}

function highestPriorityMatch(
  rules: ReadonlyArray<RoutingRule>,
  phrase: string,
): ReadonlyArray<RoutingRule> {
  const matches = rules.filter((rule) => matchesPattern(rule.pattern, phrase))
  if (matches.length === 0) {
    return []
  }
  const bestPriority = Math.min(...matches.map((rule) => rule.priority))
  return matches.filter((rule) => rule.priority === bestPriority)
}

describe('DX routing', () => {
  const rules: ReadonlyArray<RoutingRule> = (squadConfig.routing?.rules ??
    []) as ReadonlyArray<RoutingRule>

  it('routes contributor-tooling and infrastructure phrases to the expected single rule', () => {
    const cases: ReadonlyArray<{phrase: string; expectedDescription: string}> = [
      {
        phrase: 'fix pre-commit githook',
        expectedDescription:
          'Contributor tooling, developer-experience scaffolding, git hooks, and local dev setup.',
      },
      {
        phrase: 'scaffold a new dev-script',
        expectedDescription:
          'Contributor tooling, developer-experience scaffolding, git hooks, and local dev setup.',
      },
      {
        phrase: 'improve build performance of migration',
        expectedDescription: 'Architecture, implementation quality, and technical trade-offs.',
      },
      {
        phrase: 'refactor auth credential validation',
        expectedDescription: 'Credential, identity, least-privilege, privacy, and security work.',
      },
      {
        phrase: 'review persona onboarding docs',
        expectedDescription:
          'Operator experience, documentation, discoverability, and persona evidence.',
      },
      {
        phrase: 'CI matrix update for pnpm test',
        expectedDescription: 'CI, machine contracts, automation, and bounded execution.',
      },
    ]

    for (const {phrase, expectedDescription} of cases) {
      const winners = highestPriorityMatch(rules, phrase)
      expect(
        winners,
        `phrase ${JSON.stringify(phrase)} should match exactly one rule`,
      ).toHaveLength(1)
      expect(winners[0]?.description).toBe(expectedDescription)
    }
  })

  it('has no duplicate bare substring tokens across routing rule patterns', () => {
    const seen = new Map<string, string>()
    for (const rule of rules) {
      for (const token of tokensFor(rule.pattern)) {
        const owner = seen.get(token)
        if (owner !== undefined && owner !== rule.pattern) {
          throw new Error(
            `Routing token ${JSON.stringify(token)} appears in both ${JSON.stringify(owner)} and ${JSON.stringify(rule.pattern)}`,
          )
        }
        seen.set(token, rule.pattern)
      }
    }
    expect(seen.size).toBeGreaterThan(0)
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
