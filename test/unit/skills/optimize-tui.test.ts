import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

const skill = readFileSync('skills/optimize-tui/SKILL.md', 'utf8')
const references = {
  workflow: readFileSync('skills/optimize-tui/references/workflow.md', 'utf8'),
  evidence: readFileSync('skills/optimize-tui/references/evidence-and-media.md', 'utf8'),
  quality: readFileSync('skills/optimize-tui/references/quality-and-convergence.md', 'utf8'),
  pullRequest: readFileSync('skills/optimize-tui/references/pull-request-evidence.md', 'utf8'),
}

describe('optimize-tui skill', () => {
  it('keeps activation concise and routes detailed work through progressive references', () => {
    expect(skill).toContain('name: optimize-tui')
    expect(skill).toContain('references/workflow.md')
    expect(skill).toContain('references/evidence-and-media.md')
    expect(skill).toContain('references/quality-and-convergence.md')
    expect(skill).toContain('references/pull-request-evidence.md')
    expect(skill).toContain('below 5 MiB')
    expect(skill.length).toBeLessThan(5_000)
    expect(skill).not.toContain('uploads.github.com')
    expect(skill).not.toContain('ffmpeg -y')
  })

  it('documents deterministic capture, media packaging, convergence, and PR publishing', () => {
    expect(references.workflow).toContain('pnpm tui:evidence')
    expect(references.workflow).toContain('Claude Code CLI and Grok Build')
    expect(references.evidence).toContain('ffmpeg -y')
    expect(references.evidence).toContain('below 4.5 MiB')
    expect(references.quality).toContain('pnpm optimize:ux -- cycle')
    expect(references.quality).toContain('Return READY only when no blocking issue remains')
    expect(references.pullRequest).toContain('uploads.github.com/user-attachments/assets')
    expect(references.pullRequest).toContain('Do not paste binary data or base64')
  })

  it('is the required TUI sub-workflow for optimize-ux', () => {
    const optimizeUx = readFileSync('skills/optimize-ux/SKILL.md', 'utf8')
    const optimizeUxWorkflow = readFileSync('skills/optimize-ux/references/workflow.md', 'utf8')
    const optimizeUxDelivery = readFileSync(
      'skills/optimize-ux/references/safety-and-delivery.md',
      'utf8',
    )

    expect(optimizeUx).toContain('../optimize-tui/SKILL.md')
    expect(optimizeUxWorkflow).toContain('../../optimize-tui/SKILL.md')
    expect(optimizeUxDelivery).toContain('../../optimize-tui/SKILL.md')
  })
})
