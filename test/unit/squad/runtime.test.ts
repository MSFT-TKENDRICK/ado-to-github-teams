import {describe, expect, it} from 'vitest'
import {
  createSessionHooks,
  configuredToolsForAgent,
  resolveRoutedAgents,
  SquadRuntimePolicy,
  summarizePermissionRequest,
} from '../../../scripts/squad-runtime.js'

describe('SDK-first Squad runtime', () => {
  it('prefers an explicitly addressed agent over inferred routing', () => {
    expect(
      resolveRoutedAgents('Maya, review the authentication help.').map((agent) => agent.name),
    ).toEqual(['maya'])
  })

  it('routes matching work by configured priority and leaves unmatched work to the coordinator', () => {
    expect(
      resolveRoutedAgents('Review credential and secret handling.').map((agent) => agent.name),
    ).toEqual(['nia', 'rai'])
    expect(resolveRoutedAgents('Summarize the current repository.')).toEqual([])
    expect(resolveRoutedAgents('Summarize our decisions.')).toEqual([])
    expect(resolveRoutedAgents('Review pricing behavior.')).toEqual([])
    expect(resolveRoutedAgents('Explain the specification.')).toEqual([])
  })

  it('preserves each agent tool allowlist', () => {
    expect(configuredToolsForAgent('rai')).toEqual(['read_file', 'grep_search', 'file_search'])
    expect(configuredToolsForAgent('elena')).toContain('apply_patch')
    expect(configuredToolsForAgent('elena')).toContain('shell')
  })

  it('enforces configured write paths and blocked commands through SDK session hooks', async () => {
    const policy = new SquadRuntimePolicy()
    const hooks = createSessionHooks('elena', policy.pipelineFor('elena'))

    await expect(
      hooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'edit',
          toolArgs: {path: 'src/cli.ts'},
        },
        {sessionId: 'allowed'},
      ),
    ).resolves.toMatchObject({permissionDecision: 'allow'})
    await expect(
      hooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'edit',
          toolArgs: {path: '../outside.txt'},
        },
        {sessionId: 'blocked-path'},
      ),
    ).resolves.toMatchObject({permissionDecision: 'deny'})
    await expect(
      hooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'powershell',
          toolArgs: {command: 'git reset --hard'},
        },
        {sessionId: 'blocked-command'},
      ),
    ).resolves.toMatchObject({permissionDecision: 'deny'})
    await expect(
      hooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'apply_patch',
          toolArgs: {
            value: '*** Begin Patch\n*** Add File: ../outside.txt\n+not allowed\n*** End Patch\n',
          },
        },
        {sessionId: 'blocked-patch-path'},
      ),
    ).resolves.toMatchObject({permissionDecision: 'deny'})
  })

  it('mechanically enforces reviewer lockout before a rejected artifact is rewritten', async () => {
    const policy = new SquadRuntimePolicy()
    policy.lockout('src/auth.ts', 'nia')
    const hooks = createSessionHooks('nia', policy.pipelineFor('nia'))

    await expect(
      hooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'edit',
          toolArgs: {path: 'src/auth.ts'},
        },
        {sessionId: 'review-rejection'},
      ),
    ).resolves.toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('Reviewer lockout'),
    })
    await expect(
      hooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'apply_patch',
          toolArgs: {
            value:
              '*** Begin Patch\n*** Update File: src/internal/../auth.ts\n@@\n-old\n+new\n*** End Patch\n',
          },
        },
        {sessionId: 'patch-bypass'},
      ),
    ).resolves.toMatchObject({permissionDecision: 'deny'})
    await expect(
      hooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'powershell',
          toolArgs: {command: "Set-Content -Path src/auth.ts -Value 'bypass'"},
        },
        {sessionId: 'shell-bypass'},
      ),
    ).resolves.toMatchObject({permissionDecision: 'deny'})

    const coordinatorHooks = createSessionHooks('squad', policy.pipelineFor('squad'))
    await expect(
      coordinatorHooks.onPreToolUse?.(
        {
          timestamp: 0,
          cwd: process.cwd(),
          toolName: 'edit',
          toolArgs: {path: 'src/auth.ts'},
        },
        {sessionId: 'coordinator-bypass'},
      ),
    ).resolves.toMatchObject({permissionDecision: 'deny'})
  })

  it('redacts and flags sensitive permission details', () => {
    const result = summarizePermissionRequest({
      kind: 'mcp',
      toolCallId: 'call-1',
      toolName: 'squad_state_write',
      args: {
        content: 'safe metadata',
        password: 'opaque-sensitive-value',
      },
    })

    expect(result.containsSensitiveValue).toBe(true)
    expect(result.summary).toEqual({
      kind: 'mcp',
      toolCallId: 'call-1',
      toolName: 'squad_state_write',
      args: {
        content: 'safe metadata',
        password: '[REDACTED]',
      },
    })
    expect(JSON.stringify(result.summary)).not.toContain('opaque-sensitive-value')
  })
})
