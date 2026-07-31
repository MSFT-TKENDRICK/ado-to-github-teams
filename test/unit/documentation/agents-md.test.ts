import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {DESIRABILITY_SCALE_DESCRIPTION} from '../../../src/experience/agent-bus.js'

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

  it('never re-introduces the incorrect "matches prediction exactly" language for degree', async () => {
    const agents = await repositoryFile('AGENTS.md')
    // The 0.5 anchor is neutral/mixed desirability, NOT "matches prediction exactly" — that would
    // conflate degree (desirability) with delta (comparison).
    expect(agents).not.toContain('matches prediction exactly')
  })

  it('describes the corrected recordOutcome(ack, payload) API shape and unforgeable ack', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toContain('recordOutcome(ack, payload)')
    expect(agents).toMatch(/unforgeable|non-forgeable|branded/i)
  })

  it('describes run-scoped output paths (per-run isolation), not the old per-persona single file', async () => {
    const agents = await repositoryFile('AGENTS.md')
    // Post-revision: files live under a runId directory so fresh runs never share on-disk state.
    expect(agents).toContain('{runId}.jsonl')
    // The stale single-file path must NOT be present verbatim.
    expect(agents).not.toContain('/{personaId}.jsonl')
  })

  it('describes the enforced persona/domain/skill matrix so callers know operator↔optimize-ux and developer↔optimize-dx are strict', async () => {
    const agents = await repositoryFile('AGENTS.md')
    expect(agents).toMatch(/PersonaDomainSkillMismatchFailure/)
  })
})
