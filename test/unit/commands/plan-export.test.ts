import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import path from 'node:path'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {CheckpointManager} from '../../../src/checkpoints/manager.js'
import PlanExport from '../../../src/commands/plan/export.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointState,
  type MappingResult,
} from '../../../src/types/index.js'

const configurationHash = 'a'.repeat(64)

function checkpoint(): CheckpointState {
  const mapping: MappingResult = {
    adoTeam: {
      id: 'team-1',
      name: 'Platform',
      projectId: 'project-1',
      projectName: 'Engineering',
    },
    githubTeam: {
      slug: 'platform',
      name: 'Platform',
      privacy: 'closed',
    },
    memberMappings: [
      {
        adoIdentity: {
          id: 'user-1',
          displayName: 'Ada Lovelace',
          uniqueName: 'ada@contoso.com',
          isContainer: false,
        },
        githubUser: {login: 'ada', type: 'User'},
        mapped: true,
      },
    ],
    edgeCases: [],
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    configurationHash,
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Engineering',
    githubOrg: 'contoso',
    migrationConfig: {
      apply: false,
      prefix: '',
      suffix: '',
      topologyDigest: '',
      allowAdmin: false,
    },
    phase: 'dry-run',
    completedTeams: [],
    completedMemberPairs: [],
    completedRepositoryGrants: [],
    pendingTeams: [mapping.adoTeam],
    mappings: [mapping],
    teamPlan: [
      {
        team: mapping.githubTeam,
        kind: 'flat',
        sourceAdoTeamIds: [mapping.adoTeam.id],
      },
    ],
    repositoryGrants: [],
    edgeCases: [],
    skippedItems: [],
    failureLog: [],
    approvalHistory: [],
  }
}

function captureStdout(): string[] {
  const collected: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    collected.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  return collected
}

describe('plan export command', () => {
  let workDir: string
  let databasePath: string
  const originalToken = process.env.WORKFLOW_API_TOKEN
  const originalExitCode = process.exitCode

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(process.cwd(), 'plan-export-test-'))
    databasePath = path.join(workDir, 'workflow.db')
    await new CheckpointManager(databasePath).save(checkpoint())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = originalExitCode
    if (originalToken === undefined) {
      delete process.env.WORKFLOW_API_TOKEN
    } else {
      process.env.WORKFLOW_API_TOKEN = originalToken
    }
  })

  afterAll(() => {
    rmSync(workDir, {recursive: true, force: true})
  })

  it('declares required run-id and output flags', () => {
    expect(PlanExport.flags['run-id'].required).toBe(true)
    expect(PlanExport.flags.output.required).toBe(true)
    expect(PlanExport.flags['checkpoint-db'].required).toBe(false)
    expect(PlanExport.description).toContain('portable, mergeable migration plan')
  })

  it('exports a stored checkpoint to a new JSON plan artifact from the local database', async () => {
    const outputPath = path.join(workDir, 'exported-plan.json')
    const stdout = captureStdout()

    await PlanExport.run([
      '--run-id',
      'run-1',
      '--checkpoint-db',
      databasePath,
      '--output',
      outputPath,
    ])

    const output = stdout.join('')
    expect(output).toContain('Exported migration plan run-1 to')
    expect(output).toContain(path.resolve(outputPath))
    expect(existsSync(outputPath)).toBe(true)
  })

  it('refuses to overwrite an existing output artifact', async () => {
    const outputPath = path.join(workDir, 'exported-plan.json')

    await expect(
      PlanExport.run([
        '--run-id',
        'run-1',
        '--checkpoint-db',
        databasePath,
        '--output',
        outputPath,
      ]),
    ).rejects.toThrow(/must not already exist/)
  })

  it('fails when the requested checkpoint run id is absent from the database', async () => {
    const outputPath = path.join(workDir, 'missing-plan.json')

    await expect(
      PlanExport.run([
        '--run-id',
        'does-not-exist',
        '--checkpoint-db',
        databasePath,
        '--output',
        outputPath,
      ]),
    ).rejects.toThrow('Checkpoint does-not-exist was not found.')
    expect(existsSync(outputPath)).toBe(false)
  })

  it('requires a sufficiently long worker token when reading from the worker API', async () => {
    delete process.env.WORKFLOW_API_TOKEN
    const outputPath = path.join(workDir, 'worker-plan.json')

    await expect(PlanExport.run(['--run-id', 'run-1', '--output', outputPath])).rejects.toThrow(
      'WORKFLOW_API_TOKEN must contain at least 32 characters.',
    )
    expect(existsSync(outputPath)).toBe(false)
  })
})
