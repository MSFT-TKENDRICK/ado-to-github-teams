import path from 'node:path'

import {Either} from 'effect'
import fc from 'fast-check'
import {describe, expect, it} from 'vitest'

import {
  deriveDomainFromPersonaId,
  redactSecrets,
  validatePathSafety,
  validatePersonaMatrix,
  type IntentInput,
} from '../../../src/experience/agent-bus.js'
import {
  DEVELOPER_PERSONA_IDS,
  OPERATOR_PERSONA_IDS,
  PERSONA_DEFINITIONS,
} from '../../../src/experience/personas.js'

/**
 * Property-based coverage for the agent-bus security invariants that AGENTS.md states as hard
 * guarantees. Those written guarantees are free oracles: each one is a universally quantified
 * claim, which is exactly what a property test can falsify and an example test cannot.
 *
 * The seed is pinned so a failure is reproducible and a green run never becomes red on a rerun —
 * an unpinned generator in a required gate is a nondeterministic build waiting to happen.
 */
const PROPERTY_CONFIG = {
  seed: 0x5eed,
  numRuns: 300,
} as const

/**
 * Secret-shaped inputs are assembled at runtime and never written as literals.
 *
 * This is not stylistic. `pnpm check` LEADS with `secrets:check` (varlock scan), and this
 * repository is pushed to GitHub with secret-scanning push protection. A committed literal
 * `ghp_<40 chars>` or a full `AKIA…` key inside the redactor's own test would be flagged as a
 * leak — the test proving secrets get scrubbed would itself look like a scrubbing failure.
 * Composing the shapes from generated fragments keeps the assertions honest and the file clean.
 */
const GITHUB_TOKEN_PREFIXES = ['ghp', 'gho', 'ghu', 'ghs', 'ghr'] as const

const charsOf = (alphabet: string) => fc.constantFrom(...alphabet.split(''))

const ALPHANUMERIC = charsOf('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
const UPPER_ALPHANUMERIC = charsOf('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
const BASE64_URL = charsOf('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-')
const LOWER_HEX = charsOf('0123456789abcdef')

const stringOf = (alphabet: fc.Arbitrary<string>, minLength: number, maxLength: number) =>
  fc.array(alphabet, {minLength, maxLength}).map((chars) => chars.join(''))

const githubToken = fc
  .tuple(fc.constantFrom(...GITHUB_TOKEN_PREFIXES), stringOf(ALPHANUMERIC, 20, 40))
  .map(([prefix, body]) => `${prefix}_${body}`)

const awsAccessKeyId = stringOf(UPPER_ALPHANUMERIC, 16, 16).map((body) => `AKIA${body}`)

const jsonWebToken = fc
  .tuple(stringOf(BASE64_URL, 10, 24), stringOf(BASE64_URL, 10, 24), stringOf(BASE64_URL, 10, 24))
  .map(([header, payload, signature]) => `eyJ${header}.${payload}.${signature}`)

const bearerCredential = stringOf(BASE64_URL, 16, 48).map((body) => `Bearer ${body}`)

const LABELLED_CREDENTIAL_KEYS = [
  'pat',
  'token',
  'secret',
  'password',
  'pwd',
  'apikey',
  'api_key',
  'accountkey',
  'sharedaccesskey',
  'connectionstring',
  'conn_str',
  'clientsecret',
  'client_secret',
] as const

const labelledCredential = fc
  .tuple(
    fc.constantFrom(...LABELLED_CREDENTIAL_KEYS),
    fc.constantFrom(':', '='),
    stringOf(ALPHANUMERIC, 16, 48),
  )
  .map(([key, separator, value]) => `${key}${separator}${value}`)

/** A bare 40-character lowercase hex string — i.e. a git commit SHA quoted in prose. */
const commitSha = stringOf(LOWER_HEX, 40, 40)

const anySecret = fc.oneof(
  githubToken,
  awsAccessKeyId,
  jsonWebToken,
  bearerCredential,
  labelledCredential,
)

/**
 * Surrounding prose that cannot itself perturb a token boundary. `redactSecrets` anchors most of
 * its patterns on `\b`, so a generated neighbour ending in a word character would legitimately
 * suppress a match. Constraining the padding to spaces and punctuation keeps each property
 * testing redaction rather than re-testing the definition of a word boundary.
 */
const prose = fc
  .array(charsOf('abcdefghijklmnopqrstuvwxyz .,;()[]{}!?\n\t'), {maxLength: 40})
  .map((chars) => chars.join(''))

describe('agent-bus redaction properties', () => {
  it('never lets a labelled secret survive redaction', () => {
    fc.assert(
      fc.property(anySecret, prose, prose, (secret, before, after) => {
        const redacted = redactSecrets(`${before} ${secret} ${after}`)
        expect(redacted).not.toContain(secret)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('redacts every secret when many appear in one value', () => {
    fc.assert(
      fc.property(fc.array(anySecret, {minLength: 2, maxLength: 6}), (secrets) => {
        const redacted = redactSecrets(secrets.join(' and then '))
        for (const secret of secrets) {
          expect(redacted).not.toContain(secret)
        }
      }),
      PROPERTY_CONFIG,
    )
  })

  it('redacts a JWT whose final segment ends in a base64url hyphen', () => {
    // Regression: the tail anchor used to be `\b`. Because `-` is not a word character, a JWT
    // signature ending in `-` could never satisfy the boundary and passed through in the clear.
    // Property-based generation found this; the explicit case keeps the fix pinned by name.
    fc.assert(
      fc.property(
        stringOf(BASE64_URL, 10, 24),
        stringOf(BASE64_URL, 10, 24),
        stringOf(BASE64_URL, 9, 23),
        (header, payload, signatureBody) => {
          const token = `eyJ${header}.${payload}.${signatureBody}-`
          expect(redactSecrets(`context ${token} tail`)).not.toContain(token)
        },
      ),
      PROPERTY_CONFIG,
    )
  })

  it('preserves a bare 40-character hex commit SHA', () => {
    // Explicitly documented non-behaviour: the redactor must NOT match bare hex, so a commit SHA
    // quoted in a persona prediction stays readable. This is the guard against over-redaction.
    fc.assert(
      fc.property(commitSha, prose, (sha, context) => {
        expect(redactSecrets(`${context} commit ${sha} landed`)).toContain(sha)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), anySecret, (noise, secret) => {
        const once = redactSecrets(`${noise} ${secret}`)
        expect(redactSecrets(once)).toBe(once)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('is total over arbitrary unicode input', () => {
    fc.assert(
      fc.property(fc.string({unit: 'binary'}), (value) => {
        expect(() => redactSecrets(value)).not.toThrow()
      }),
      PROPERTY_CONFIG,
    )
  })

  it('leaves values containing no secret shape untouched', () => {
    fc.assert(
      fc.property(prose, (value) => {
        expect(redactSecrets(value)).toBe(value)
      }),
      PROPERTY_CONFIG,
    )
  })
})

describe('agent-bus path-safety properties', () => {
  /**
   * The live layer writes to `reports/agent-bus/{skill}/{personaId}/{runId}.jsonl`. This models
   * that exact join, which is the only thing that matters: an accepted identifier must be unable
   * to address any file outside its intended directory.
   */
  const containedWithinBase = (base: string, identifier: string): boolean => {
    const joined = path.resolve(base, `${identifier}.jsonl`)
    return path.dirname(joined) === base
  }

  it('never accepts an identifier that can escape its directory', () => {
    const base = path.resolve(path.sep, 'agent-bus-base')
    fc.assert(
      fc.property(
        fc.string({unit: 'binary', maxLength: 200}),
        fc.constantFrom('personaId' as const, 'runId' as const, 'resumeFromRunId' as const),
        (candidate, field) => {
          const result = validatePathSafety(field, candidate)
          if (Either.isLeft(result)) {
            return
          }
          expect(containedWithinBase(base, result.right)).toBe(true)
        },
      ),
      PROPERTY_CONFIG,
    )
  })

  it('rejects every documented unsafe class before any filesystem access', () => {
    const unsafe = fc.oneof(
      fc.constant(''),
      stringOf(ALPHANUMERIC, 129, 400),
      fc.tuple(prose, prose).map(([a, b]) => `${a}\u0000${b}`),
      fc.tuple(prose, prose).map(([a, b]) => `${a}/${b}`),
      fc.tuple(prose, prose).map(([a, b]) => `${a}\\${b}`),
      fc.tuple(prose, prose).map(([a, b]) => `${a}..${b}`),
    )
    fc.assert(
      fc.property(unsafe, (candidate) => {
        const result = validatePathSafety('runId', candidate)
        expect(Either.isLeft(result)).toBe(true)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('accepts well-formed identifiers', () => {
    fc.assert(
      fc.property(stringOf(ALPHANUMERIC, 1, 128), (candidate) => {
        expect(Either.isRight(validatePathSafety('runId', candidate))).toBe(true)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('surfaces a bounded, value-free failure', () => {
    // AGENTS.md: "only tag/class name, field name or path, line number, and reason code are
    // exposed; no raw parsed value ... is ever embedded in a failure."
    fc.assert(
      fc.property(fc.string({unit: 'binary', minLength: 12, maxLength: 200}), (candidate) => {
        const result = validatePathSafety('runId', candidate)
        if (Either.isRight(result)) {
          return
        }
        const failure = result.left
        // `_tag` is the Data.TaggedError discriminant — AGENTS.md permits the tag/class name.
        // What must never appear is the rejected value itself.
        expect([...Object.keys(failure)].sort()).toEqual(['_tag', 'field', 'reason'])
        expect(failure.field).toBe('runId')
        expect(`${failure._tag}${failure.field}${failure.reason}`).not.toContain(candidate)
      }),
      PROPERTY_CONFIG,
    )
  })
})

describe('agent-bus persona matrix properties', () => {
  const baseIntent = (
    personaId: string,
    domain: IntentInput['domain'],
    skill: IntentInput['skill'],
  ): IntentInput => ({
    correlationId: 'correlation-1',
    personaId,
    domain,
    skill,
    iteration: 1,
    perceivedInterface: 'a terminal dashboard',
    intendedAction: 'run the migration plan',
    expectedResult: 'a dry-run summary',
  })

  it('accepts exactly the declared persona/domain/skill triples', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PERSONA_DEFINITIONS), (persona) => {
        const skill = persona.domain === 'operator' ? 'optimize-ux' : 'optimize-dx'
        const result = validatePersonaMatrix(baseIntent(persona.id, persona.domain, skill))
        expect(Either.isRight(result)).toBe(true)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('rejects every mispaired skill', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PERSONA_DEFINITIONS), (persona) => {
        const wrongSkill = persona.domain === 'operator' ? 'optimize-dx' : 'optimize-ux'
        const result = validatePersonaMatrix(baseIntent(persona.id, persona.domain, wrongSkill))
        expect(Either.isLeft(result)).toBe(true)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('rejects an operator persona claiming the developer domain and vice versa', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PERSONA_DEFINITIONS), (persona) => {
        const wrongDomain = persona.domain === 'operator' ? 'developer' : 'operator'
        const skill = wrongDomain === 'operator' ? 'optimize-ux' : 'optimize-dx'
        const result = validatePersonaMatrix(baseIntent(persona.id, wrongDomain, skill))
        expect(Either.isLeft(result)).toBe(true)
      }),
      PROPERTY_CONFIG,
    )
  })

  it('rejects any persona id outside the declared matrix', () => {
    const known = new Set<string>(PERSONA_DEFINITIONS.map((persona) => persona.id))
    fc.assert(
      fc.property(
        stringOf(ALPHANUMERIC, 1, 60),
        fc.constantFrom('operator' as const, 'developer' as const),
        (candidate, domain) => {
          fc.pre(!known.has(candidate))
          const skill = domain === 'operator' ? 'optimize-ux' : 'optimize-dx'
          const result = validatePersonaMatrix(baseIntent(candidate, domain, skill))
          expect(Either.isLeft(result)).toBe(true)
        },
      ),
      PROPERTY_CONFIG,
    )
  })

  it('derives the domain of every declared persona and nothing else', () => {
    for (const persona of PERSONA_DEFINITIONS) {
      expect(deriveDomainFromPersonaId(persona.id)).toBe(persona.domain)
    }
    fc.assert(
      fc.property(stringOf(ALPHANUMERIC, 1, 60), (candidate) => {
        fc.pre(!PERSONA_DEFINITIONS.some((persona) => persona.id === candidate))
        expect(deriveDomainFromPersonaId(candidate)).toBeUndefined()
      }),
      PROPERTY_CONFIG,
    )
  })

  it('keeps the operator and developer id sets disjoint and exhaustive', () => {
    // Widened to `Set<string>` deliberately: the exported id arrays carry narrow literal unions,
    // so a same-typed set would make the disjointness check a compile-time tautology instead of a
    // runtime assertion about the actual data.
    const operators = new Set<string>(OPERATOR_PERSONA_IDS)
    const developers = new Set<string>(DEVELOPER_PERSONA_IDS)
    for (const id of operators) {
      expect(developers.has(id)).toBe(false)
    }
    expect(operators.size + developers.size).toBe(PERSONA_DEFINITIONS.length)
  })
})
