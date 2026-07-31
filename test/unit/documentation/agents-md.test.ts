import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  DESIRABILITY_SCALE_DESCRIPTION,
  TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION,
} from '../../../src/experience/agent-bus.js'

async function repositoryFile(file: string): Promise<string> {
  return readFile(path.join(process.cwd(), file), 'utf8')
}

describe('AGENTS.md write-ahead persona protocol contract', () => {
  it('quotes DESIRABILITY_SCALE_DESCRIPTION VERBATIM — the source of truth cannot silently drift', async () => {
    // The `degree` scale wording lives in `src/experience/agent-bus.ts` as the ONE authoritative
    // string. AGENTS.md must quote it exactly. If a future patch paraphrases either, this test
    // fails and forces the two back into agreement.
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain(DESIRABILITY_SCALE_DESCRIPTION)
  })

  it('quotes TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION VERBATIM — corrected wording cannot regress to false absolute-guarantee language', async () => {
    // The corrected guarantee — "attempt is guaranteed; success is not" — lives in agent-bus.ts
    // as the SINGLE source of truth. AGENTS.md must quote it verbatim so the two cannot drift
    // back into the old, false "never left with a dangling intent" absolute claim.
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain(TERMINAL_OUTCOME_GUARANTEE_DESCRIPTION)
  })

  it('never re-introduces the incorrect "matches prediction exactly" language for degree', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).not.toContain('matches prediction exactly')
  })

  it('never re-introduces the false absolute-guarantee language for the terminal-outcome contract', async () => {
    // The corrected contract is an ATTEMPT guarantee. These phrases represent the pre-correction
    // false absolute-guarantee wording that was rejected by adversarial review and MUST NOT
    // return in AGENTS.md or any skill reference file.
    const files = [
      'AGENTS.md',
      'src/experience/agent-bus.ts',
      'src/experience/agent-bus-live.ts',
      'skills/optimize-dx/references/workflow.md',
      'skills/optimize-dx/references/qualitative-evidence.md',
      'skills/optimize-dx/SKILL.md',
      'skills/optimize-ux/SKILL.md',
    ]
    for (const file of files) {
      const contents = await readFile(path.join(process.cwd(), file), 'utf8').catch(() => '')
      expect(contents, `${file}: no "never left with a dangling" absolute claim`).not.toContain(
        'never left with a dangling',
      )
      expect(contents, `${file}: no "guarantees a terminal outcome" absolute claim`).not.toMatch(
        /guarantees a terminal outcome/i,
      )
    }
  })

  it('describes the corrected recordOutcome(ack, payload) API shape and unforgeable ack', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('recordOutcome(ack, payload)')
    expect(agents).toMatch(/unforgeable|non-forgeable|branded/i)
  })

  it('describes the corrected toOutcome(exit, ack, intent) callback shape — caller authors all four exit shapes', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('toOutcome(exit, ack, intent)')
    expect(agents).toMatch(/four (distinguishable|different) payloads/i)
  })

  it('describes the RunIdentityTag capability and the RunIdentityLive-only randomUUID rule', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('RunIdentityTag')
    expect(agents).toContain('RunIdentityLive')
    expect(agents).toMatch(/only place[\s\S]*randomUUID|randomUUID[\s\S]*only place/i)
  })

  it('describes run-scoped output paths (per-run isolation) and self-identifying persisted events', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('{runId}.jsonl')
    expect(agents).not.toContain('/{personaId}.jsonl')
    expect(agents).toMatch(/carries its `runId` in-band|carries.*runId.*in-band/i)
  })

  it('describes the enforced persona/domain/skill matrix so callers know operator↔optimize-ux and developer↔optimize-dx are strict', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toMatch(/PersonaDomainSkillMismatchFailure/)
  })

  it('describes the nine explicit resume reasons and non-ENOENT read-failure surfacing', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('duplicate-intent')
    expect(agents).toContain('duplicate-outcome')
    expect(agents).toContain('outcome-before-intent')
    expect(agents).toContain('invalid-json')
    expect(agents).toContain('protocol-version-mismatch')
    expect(agents).toContain('run-id-mismatch')
    expect(agents).toContain('scope-mismatch')
    expect(agents).toContain('matrix-violation')
    expect(agents).toContain('ResumeReadFailure')
  })

  it('describes the IntentAckMismatchFailure cross-run/stale-ack validation added in item 1', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('IntentAckMismatchFailure')
  })

  it('describes the ConflictingRunOptionsFailure up-front rejection added in item 3', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('ConflictingRunOptionsFailure')
  })

  it('describes the OutcomeAuthoringFailure carve-out for a throwing toOutcome callback (item 5)', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('OutcomeAuthoringFailure')
  })

  it('describes the resume-scope matrix pre-validation added in item 6', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toMatch(/resumeScopes[\s\S]*matrix|matrix[\s\S]*resumeScopes/i)
  })

  it('states that every externally-surfaced bus failure is bounded and value-free (item 4)', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toMatch(/bounded and value-free/i)
  })
})
