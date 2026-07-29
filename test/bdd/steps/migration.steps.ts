import assert from 'node:assert/strict'
import {Given, Then, When, World, setWorldConstructor, type IWorldOptions} from '@cucumber/cucumber'
import {Effect, Layer} from 'effect'
import {runEffectMigration, type EffectMigrationOptions} from '../../../src/effect/migration.js'
import {
  PermissionFailure,
  ValidationFailure,
  type DomainFailure,
} from '../../../src/effect/errors.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  CheckpointStoreTag,
  EntraServiceTag,
  GitHubServiceTag,
  ReportWriterTag,
} from '../../../src/effect/services.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type AdoMember,
  type AdoTeam,
  type ApprovalRecord,
  type ApprovalRequest,
  type CheckpointState,
  type EntraIdentity,
  type GitHubTeam,
  type GitHubUser,
  type MigrationReport,
} from '../../../src/types/index.js'

const TEAM: AdoTeam = {
  id: 'team-1',
  name: 'Platform',
  projectId: 'project-1',
  projectName: 'Engineering',
}

const MEMBER: AdoMember = {
  id: 'user-1',
  displayName: 'Avery Example',
  uniqueName: 'avery@example.com',
  email: 'avery@example.com',
  isContainer: false,
}

const IDENTITY: EntraIdentity = {
  id: 'entra-user-1',
  displayName: 'Avery Example',
  userPrincipalName: 'avery@example.com',
  mail: 'avery@example.com',
  accountEnabled: true,
  isGuest: false,
}

const GITHUB_USER: GitHubUser = {
  login: 'avery-example',
  email: 'avery@example.com',
  type: 'User',
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function mappedMemberCount(report: MigrationReport): number {
  return report.mappings.reduce(
    (total, mapping) => total + mapping.memberMappings.filter((member) => member.mapped).length,
    0,
  )
}

class MigrationWorld extends World {
  public options: EffectMigrationOptions = {
    adoOrg: 'https://dev.azure.com/example',
    adoProject: 'Engineering',
    githubOrg: 'example-enterprise',
    apply: false,
    concurrency: 1,
  }

  public teams: AdoTeam[] = [clone(TEAM)]
  public membersByTeam = new Map<string, AdoMember[]>([[TEAM.id, [clone(MEMBER)]]])
  public identitiesByUpn = new Map<string, EntraIdentity>([[MEMBER.uniqueName, clone(IDENTITY)]])
  public githubUsersByEmail = new Map<string, GitHubUser>([
    [IDENTITY.mail ?? '', clone(GITHUB_USER)],
  ])
  public suspendedLogins = new Set<string>()
  public existingTeamsBySlug = new Map<string, GitHubTeam>()
  public groupOrigins = new Map<string, string>()
  public groupMembers = new Map<string, EntraIdentity[]>()
  public groupRequests: Array<{groupId: string; transitive: boolean}> = []
  public approvalAnswers: boolean[] = []
  public approvalRequests: ApprovalRequest[] = []
  public approvalHistory: ApprovalRecord[] = []
  public savedStates: CheckpointState[] = []
  public deletedCheckpoints: string[] = []
  public reports: MigrationReport[] = []
  public providerOperations: string[] = []
  public writeOperations: string[] = []
  public firstTeamWriteCheckpoint?: CheckpointState
  public firstMemberWriteCheckpoint?: CheckpointState
  public lastCheckpoint?: CheckpointState
  public resumeCheckpoint?: CheckpointState
  public resumeCheckpointBaseline?: string
  public createFailure?: DomainFailure
  public addFailure?: DomainFailure
  public ambiguousGitHubMatch = false
  public activeMemberReads = 0
  public peakMemberReads = 0
  public result?: {reportPath: string; runId: string}
  public error?: Error

  public constructor(options: IWorldOptions) {
    super(options)
  }

  public async run(): Promise<void> {
    const checkpointStore = {
      save: (state: CheckpointState) =>
        Effect.sync(() => {
          const saved = clone(state)
          this.savedStates.push(saved)
          this.lastCheckpoint = saved
        }),
      load: (runId: string) =>
        Effect.succeed(
          this.resumeCheckpoint?.runId === runId ? clone(this.resumeCheckpoint) : null,
        ),
      latest: Effect.succeed(this.resumeCheckpoint ? clone(this.resumeCheckpoint) : null),
      list: Effect.succeed([]),
      delete: (runId: string) =>
        Effect.sync(() => {
          this.deletedCheckpoints.push(runId)
        }),
    }

    const layer = Layer.mergeAll(
      Layer.succeed(AdoServiceTag, {
        getTeams: () =>
          Effect.sync(() => {
            this.providerOperations.push('ado:get-teams')
            return clone(this.teams)
          }),
        getTeamMembers: (_projectId: string, teamId: string) =>
          Effect.sync(() => {
            this.providerOperations.push(`ado:get-members:${teamId}`)
            this.activeMemberReads += 1
            this.peakMemberReads = Math.max(this.peakMemberReads, this.activeMemberReads)
          }).pipe(
            Effect.zipRight(Effect.sleep('10 millis')),
            Effect.zipRight(Effect.sync(() => clone(this.membersByTeam.get(teamId) ?? []))),
            Effect.ensuring(
              Effect.sync(() => {
                this.activeMemberReads -= 1
              }),
            ),
          ),
        resolveGroupOriginId: (descriptor: string) =>
          Effect.sync(() => {
            this.providerOperations.push(`ado:resolve-group:${descriptor}`)
            return this.groupOrigins.get(descriptor) ?? null
          }),
      }),
      Layer.succeed(GitHubServiceTag, {
        getTeamBySlug: (slug: string) =>
          Effect.sync(() => {
            this.providerOperations.push(`github:get-team:${slug}`)
            return clone(this.existingTeamsBySlug.get(slug) ?? null)
          }),
        createTeam: (team: Omit<GitHubTeam, 'id'>) =>
          Effect.gen(this, function* () {
            this.providerOperations.push(`github:create-team:${team.slug}`)
            this.writeOperations.push(`create:${team.slug}`)
            if (!this.firstTeamWriteCheckpoint && this.lastCheckpoint) {
              this.firstTeamWriteCheckpoint = clone(this.lastCheckpoint)
            }
            if (this.createFailure) {
              return yield* Effect.fail(this.createFailure)
            }
            return {...team, id: 1}
          }),
        addTeamMember: (teamSlug: string, login: string) =>
          Effect.gen(this, function* () {
            this.providerOperations.push(`github:add-member:${teamSlug}:${login}`)
            this.writeOperations.push(`member:${teamSlug}:${login}`)
            if (!this.firstMemberWriteCheckpoint && this.lastCheckpoint) {
              this.firstMemberWriteCheckpoint = clone(this.lastCheckpoint)
            }
            if (this.addFailure) {
              return yield* Effect.fail(this.addFailure)
            }
          }),
        findUserByEmail: (email: string) =>
          Effect.gen(this, function* () {
            this.providerOperations.push(`github:find-user:${email}`)
            if (this.ambiguousGitHubMatch) {
              return yield* Effect.fail(
                new ValidationFailure({
                  service: 'github',
                  message: `Multiple GitHub users match email ${email}`,
                }),
              )
            }
            return clone(this.githubUsersByEmail.get(email) ?? null)
          }),
        isUserSuspended: (login: string) =>
          Effect.sync(() => {
            this.providerOperations.push(`github:is-suspended:${login}`)
            return this.suspendedLogins.has(login)
          }),
      }),
      Layer.succeed(EntraServiceTag, {
        getGroupMembers: (groupId: string, transitive = false) =>
          Effect.sync(() => {
            this.providerOperations.push(`entra:get-group-members:${groupId}`)
            this.groupRequests.push({groupId, transitive})
            return clone(this.groupMembers.get(groupId) ?? [])
          }),
        resolveUserByUpn: (upn: string) =>
          Effect.sync(() => {
            this.providerOperations.push(`entra:resolve-user:${upn}`)
            return clone(this.identitiesByUpn.get(upn) ?? null)
          }),
      }),
      Layer.succeed(CheckpointStoreTag, checkpointStore),
      Layer.succeed(ApprovalServiceTag, {
        request: (request: ApprovalRequest) =>
          Effect.sync(() => {
            const approved = this.approvalAnswers.shift() ?? true
            this.approvalRequests.push(clone(request))
            this.approvalHistory.push({
              action: request.action,
              context: JSON.stringify(request.context),
              approved,
              timestamp: '2026-01-01T00:00:00.000Z',
            })
            return approved
          }),
        history: Effect.sync(() => clone(this.approvalHistory)),
      }),
      Layer.succeed(ReportWriterTag, {
        write: (report: MigrationReport) =>
          Effect.sync(() => {
            this.reports.push(clone(report))
          }),
      }),
    )

    try {
      this.result = await Effect.runPromise(
        runEffectMigration(this.options).pipe(Effect.provide(layer)),
      )
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error))
    }
  }
}

setWorldConstructor(MigrationWorld)

Given('a standard team migration', function (this: MigrationWorld) {
  assert.equal(this.teams.length, 1)
})

Given('the operator rejects team creation', function (this: MigrationWorld) {
  this.approvalAnswers = [false]
})

Given(
  'GitHub requires SSO authorization while creating the team and the operator skips that team',
  function (this: MigrationWorld) {
    this.createFailure = new PermissionFailure({
      service: 'github',
      message: 'GitHub SSO authorization is required',
      status: 403,
      ssoRequired: true,
    })
    this.approvalAnswers = [true, true, true]
  },
)

Given('two source teams normalize to the same GitHub slug', function (this: MigrationWorld) {
  const secondTeam: AdoTeam = {
    ...clone(TEAM),
    id: 'team-2',
    name: 'platform',
  }
  this.teams = [clone(TEAM), secondTeam]
  this.membersByTeam.set(secondTeam.id, [])
})

Given(
  'a checkpoint whose {string} differs from this run',
  function (this: MigrationWorld, setting: string) {
    this.options = {...this.options, apply: true, resume: 'resume-1'}
    const checkpoint: CheckpointState = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      runId: 'resume-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      adoOrg: this.options.adoOrg,
      adoProject: this.options.adoProject,
      githubOrg: this.options.githubOrg,
      migrationConfig: {
        apply: this.options.apply,
        prefix: this.options.prefix ?? '',
        suffix: this.options.suffix ?? '',
      },
      phase: 'fetch',
      completedTeams: [],
      completedMemberPairs: [],
      pendingTeams: [],
      mappings: [],
      edgeCases: [],
      skippedItems: [],
      failureLog: [],
      approvalHistory: [],
    }
    switch (setting) {
      case 'ADO organization':
        checkpoint.adoOrg = 'https://dev.azure.com/other'
        break
      case 'ADO project':
        checkpoint.adoProject = 'Other'
        break
      case 'GitHub organization':
        checkpoint.githubOrg = 'other-enterprise'
        break
      case 'apply mode':
        checkpoint.migrationConfig.apply = false
        break
      case 'prefix':
        checkpoint.migrationConfig.prefix = 'legacy-'
        break
      case 'suffix':
        checkpoint.migrationConfig.suffix = '-legacy'
        break
      default:
        throw new Error(`Unknown checkpoint setting: ${setting}`)
    }
    this.resumeCheckpoint = checkpoint
    this.resumeCheckpointBaseline = JSON.stringify(checkpoint)
  },
)

Given('the source member is {string}', function (this: MigrationWorld, condition: string) {
  switch (condition) {
    case 'an Entra guest':
      this.identitiesByUpn.set(MEMBER.uniqueName, {...clone(IDENTITY), isGuest: true})
      break
    case 'disabled in Entra':
      this.identitiesByUpn.set(MEMBER.uniqueName, {...clone(IDENTITY), accountEnabled: false})
      break
    case 'unresolved in Entra':
      this.identitiesByUpn.clear()
      break
    case 'missing a valid email or UPN': {
      const member = {...clone(MEMBER), uniqueName: 'avery@invalid'}
      delete member.email
      this.membersByTeam.set(TEAM.id, [member])
      this.identitiesByUpn.clear()
      this.identitiesByUpn.set(member.uniqueName, {
        ...clone(IDENTITY),
        userPrincipalName: member.uniqueName,
      })
      delete this.identitiesByUpn.get(member.uniqueName)?.mail
      break
    }
    case 'missing a GitHub EMU account':
      this.githubUsersByEmail.clear()
      break
    case 'ambiguous on GitHub':
      this.ambiguousGitHubMatch = true
      break
    case 'suspended on GitHub':
      this.suspendedLogins.add(GITHUB_USER.login)
      break
    case 'an ADO project role':
      this.membersByTeam.set(TEAM.id, [{...clone(MEMBER), displayName: 'Project Administrators'}])
      break
    case 'a non-user service identity': {
      const member = {
        ...clone(MEMBER),
        displayName: 'Release Service',
        uniqueName: 'release-service',
      }
      delete member.email
      this.membersByTeam.set(TEAM.id, [member])
      break
    }
    default:
      throw new Error(`Unknown identity condition: ${condition}`)
  }
})

Given('a source team contains an Entra-backed ADO group', function (this: MigrationWorld) {
  const group: AdoMember = {
    id: 'ado-group-1',
    descriptor: 'vssgp.example',
    displayName: 'Platform Contributors',
    uniqueName: 'Platform Contributors',
    isContainer: true,
  }
  this.membersByTeam.set(TEAM.id, [group])
  this.groupOrigins.set(group.descriptor ?? group.id, 'entra-group-1')
  this.groupMembers.set('entra-group-1', [clone(IDENTITY)])
})

Given(
  'a source team contains the same user directly and through an Entra group',
  function (this: MigrationWorld) {
    const group: AdoMember = {
      id: 'ado-group-1',
      descriptor: 'vssgp.example',
      displayName: 'Platform Contributors',
      uniqueName: 'Platform Contributors',
      isContainer: true,
    }
    this.membersByTeam.set(TEAM.id, [clone(MEMBER), group])
    this.groupOrigins.set(group.descriptor ?? group.id, 'entra-group-1')
    this.groupMembers.set('entra-group-1', [clone(IDENTITY)])
  },
)

Given(
  '{int} source teams are read with concurrency {int}',
  function (this: MigrationWorld, teamCount: number, concurrency: number) {
    this.options = {...this.options, concurrency}
    this.teams = Array.from({length: teamCount}, (_, index) => ({
      id: `team-${index + 1}`,
      name: `Team ${index + 1}`,
      projectId: 'project-1',
      projectName: 'Engineering',
    }))
    this.membersByTeam.clear()
    for (const team of this.teams) {
      this.membersByTeam.set(team.id, [])
    }
  },
)

Given('an empty source team', function (this: MigrationWorld) {
  this.membersByTeam.set(TEAM.id, [])
})

When('the migration is run in dry-run mode', async function (this: MigrationWorld) {
  this.options = {...this.options, apply: false}
  await this.run()
})

When(
  'the migration is applied with both destructive approvals',
  async function (this: MigrationWorld) {
    this.options = {...this.options, apply: true}
    this.approvalAnswers = this.approvalAnswers.length > 0 ? this.approvalAnswers : [true, true]
    await this.run()
  },
)

When('the migration is applied', async function (this: MigrationWorld) {
  this.options = {...this.options, apply: true}
  await this.run()
})

When('the checkpoint is resumed', async function (this: MigrationWorld) {
  await this.run()
})

Then('the migration succeeds', function (this: MigrationWorld) {
  assert.equal(this.error, undefined, this.error?.message)
  assert.ok(this.result)
})

Then('the migration fails with {string}', function (this: MigrationWorld, message: string) {
  assert.ok(this.error, 'Expected migration to fail')
  assert.match(this.error.message, new RegExp(message))
})

Then('no GitHub writes are attempted', function (this: MigrationWorld) {
  assert.deepEqual(this.writeOperations, [])
})

Then(
  'the dry-run report contains {int} team(s) and {int} mapped member(s)',
  function (this: MigrationWorld, teamCount: number, memberCount: number) {
    assert.equal(this.reports.length, 1)
    const report = this.reports[0]
    assert.ok(report)
    assert.equal(report.dryRun, true)
    assert.equal(report.mappings.length, teamCount)
    assert.equal(mappedMemberCount(report), memberCount)
  },
)

Then('the completed dry-run checkpoint is removed', function (this: MigrationWorld) {
  assert.ok(this.result)
  assert.deepEqual(this.deletedCheckpoints, [this.result.runId])
})

Then('team creation completes before member assignment', function (this: MigrationWorld) {
  assert.deepEqual(this.writeOperations, ['create:platform', 'member:platform:avery-example'])
})

Then(
  'team creation approval is checkpointed before the first team write',
  function (this: MigrationWorld) {
    assert.ok(this.firstTeamWriteCheckpoint)
    assert.ok(
      this.firstTeamWriteCheckpoint.approvalHistory.some(
        (record) => record.approved && record.action.startsWith('Create '),
      ),
    )
  },
)

Then(
  'member assignment approval is checkpointed before the first member write',
  function (this: MigrationWorld) {
    assert.ok(this.firstMemberWriteCheckpoint)
    assert.ok(
      this.firstMemberWriteCheckpoint.approvalHistory.some(
        (record) => record.approved && record.action.startsWith('Add '),
      ),
    )
  },
)

Then('the apply report contains both approvals', function (this: MigrationWorld) {
  const report = this.reports.at(-1)
  assert.ok(report)
  assert.equal(report.dryRun, false)
  assert.ok(report.approvalHistory.some((record) => record.action.startsWith('Create ')))
  assert.ok(report.approvalHistory.some((record) => record.action.startsWith('Add ')))
})

Then('the rejection is retained in the checkpoint', function (this: MigrationWorld) {
  assert.ok(this.lastCheckpoint)
  assert.ok(
    this.lastCheckpoint.approvalHistory.some(
      (record) => !record.approved && record.action.startsWith('Create '),
    ),
  )
})

Then('the team is reported as skipped', function (this: MigrationWorld) {
  const report = this.reports.at(-1)
  assert.ok(report)
  assert.ok(report.skippedItems.some((item) => item.type === 'team' && item.name === TEAM.name))
})

Then('no member write is attempted for the skipped team', function (this: MigrationWorld) {
  assert.equal(
    this.writeOperations.some((operation) => operation.startsWith('member:platform:')),
    false,
  )
})

Then('no provider operation is attempted', function (this: MigrationWorld) {
  assert.deepEqual(this.providerOperations, [])
})

Then('the incompatible checkpoint is not modified', function (this: MigrationWorld) {
  assert.equal(this.savedStates.length, 0)
  assert.equal(JSON.stringify(this.resumeCheckpoint), this.resumeCheckpointBaseline)
})

Then(
  /^(\d+) members? (?:is|are) eligible for migration$/,
  function (this: MigrationWorld, countText: string) {
    const report = this.reports.at(-1)
    assert.ok(report)
    assert.equal(mappedMemberCount(report), Number(countText))
  },
)

Then('no identity edge case is reported', function (this: MigrationWorld) {
  const report = this.reports.at(-1)
  assert.ok(report)
  assert.deepEqual(report.edgeCases, [])
})

Then(
  'the identity edge case {string} is reported',
  function (this: MigrationWorld, reason: string) {
    const report = this.reports.at(-1)
    assert.ok(report)
    assert.ok(report.edgeCases.some((edgeCase) => edgeCase.reason === reason))
  },
)

Then('the ADO group origin is expanded transitively', function (this: MigrationWorld) {
  assert.deepEqual(this.groupRequests, [{groupId: 'entra-group-1', transitive: true}])
})

Then('the nested member is eligible for migration', function (this: MigrationWorld) {
  const report = this.reports.at(-1)
  assert.ok(report)
  assert.equal(mappedMemberCount(report), 1)
})

Then('the member approval count is {int}', function (this: MigrationWorld, count: number) {
  const request = this.approvalRequests.find((candidate) => candidate.action.startsWith('Add '))
  assert.ok(request)
  assert.equal(request.context.memberCount, count)
})

Then('exactly {int} member write is attempted', function (this: MigrationWorld, count: number) {
  assert.equal(
    this.writeOperations.filter((operation) => operation.startsWith('member:')).length,
    count,
  )
})

Then('all {int} source teams are reported', function (this: MigrationWorld, count: number) {
  const report = this.reports.at(-1)
  assert.ok(report)
  assert.equal(report.mappings.length, count)
})

Then(
  'no more than {int} team-member reads overlap',
  function (this: MigrationWorld, concurrency: number) {
    assert.ok(this.peakMemberReads <= concurrency)
  },
)
