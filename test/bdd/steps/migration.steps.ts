import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Given, Then, When, World, setWorldConstructor, type IWorldOptions} from '@cucumber/cucumber'
import {Effect, Layer} from 'effect'
import {normalizeCliArgs} from '../../../src/cli.js'
import {configurationHash} from '../../../src/checkpoints/configuration.js'
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
import {
  renderMigrationDashboardFrame,
  TerminalDashboard,
  visibleWidth,
  type MigrationDashboardState,
  type TerminalOutput,
} from '../../../src/ui/terminal-dashboard.js'
import {loadSandboxCatalog} from '../../../src/sandbox/config.js'
import {
  runSandboxPresentationTrace,
  type SandboxPresentationTrace,
} from '../../../src/sandbox/presentation-trace.js'
import {
  SANDBOX_EXIT_SELECTION,
  SandboxScenarioRunnerTag,
  SandboxSessionUiTag,
  runSandboxSession,
} from '../../../src/sandbox/interactive-session.js'

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

interface TuiViewport {
  readonly columns: number
  readonly rows: number
}

class TuiTestOutput implements TerminalOutput {
  public isTTY = true
  public columns = 120
  public rows = 30
  public readonly writes: string[] = []
  private resizeListener: (() => void) | undefined

  public write(chunk: string): void {
    this.writes.push(chunk)
  }

  public on(event: 'resize', listener: () => void): void {
    if (event === 'resize') {
      this.resizeListener = listener
    }
  }

  public off(event: 'resize', listener: () => void): void {
    if (event === 'resize' && this.resizeListener === listener) {
      this.resizeListener = undefined
    }
  }
}

let happyPathTuiTrace: Promise<SandboxPresentationTrace> | undefined

async function loadHappyPathTuiTrace(): Promise<SandboxPresentationTrace> {
  happyPathTuiTrace ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bdd-sandbox-tui-'))
    try {
      const loaded = await Effect.runPromise(loadSandboxCatalog())
      return await Effect.runPromise(
        runSandboxPresentationTrace({
          loaded,
          scenarioId: 'happy-path',
          directory,
          runId: 'sandbox-bdd-happy-path',
        }),
      )
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  })()
  return happyPathTuiTrace
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
  public idpManagedTeamSlugs = new Set<string>()
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
  public tuiState?: MigrationDashboardState
  public tuiFrames: readonly string[][] = []
  public tuiViewports: readonly TuiViewport[] = []
  public tuiOutput?: TuiTestOutput
  public tuiTrace?: SandboxPresentationTrace
  public sandboxSessionSelections: string[] = []
  public sandboxSessionRuns: string[] = []
  public sandboxSessionLines: string[] = []
  public sandboxSessionPromptCount = 0
  public sandboxSessionPromptDefaults: Array<string | undefined> = []
  public sandboxInitialScenarioId: string | undefined

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
        isTeamIdpManaged: (teamSlug: string) =>
          Effect.sync(() => {
            this.providerOperations.push(`github:is-idp-managed:${teamSlug}`)
            return this.idpManagedTeamSlugs.has(teamSlug)
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

Given('an executed happy-path sandbox TUI migration', async function (this: MigrationWorld) {
  this.tuiTrace = await loadHappyPathTuiTrace()
  const mapping = this.tuiTrace.snapshots.find(
    ({origin, state}) => origin === 'progress' && state.phase === 'map',
  )
  assert.ok(mapping)
  this.tuiState = mapping.state
})

Given('two sandbox scenarios and an explicit exit are selected', function (this: MigrationWorld) {
  this.sandboxSessionSelections = ['happy-path', 'guest-user', SANDBOX_EXIT_SELECTION]
})

Given('the top-level happy-path sandbox command is requested', function (this: MigrationWorld) {
  const normalized = normalizeCliArgs(['--sandbox', 'happy-path'])
  assert.deepEqual(normalized, ['sandbox', '--scenario', 'happy-path'])
  this.sandboxInitialScenarioId = normalized[2]
  this.sandboxSessionSelections = [SANDBOX_EXIT_SELECTION]
})

When('the interactive sandbox session is run', async function (this: MigrationWorld) {
  const loaded = await Effect.runPromise(loadSandboxCatalog())
  const layer = Layer.merge(
    Layer.succeed(SandboxSessionUiTag, {
      choose: (_scenarios, defaultScenarioId) =>
        Effect.sync(() => {
          this.sandboxSessionPromptCount += 1
          this.sandboxSessionPromptDefaults.push(defaultScenarioId)
          return this.sandboxSessionSelections.shift() ?? SANDBOX_EXIT_SELECTION
        }),
      writeLine: (line) => Effect.sync(() => this.sandboxSessionLines.push(line)),
    }),
    Layer.succeed(SandboxScenarioRunnerTag, {
      run: (scenario) => Effect.sync(() => this.sandboxSessionRuns.push(scenario.id)),
    }),
  )

  await Effect.runPromise(
    runSandboxSession(loaded.catalog, {
      ...(this.sandboxInitialScenarioId ? {initialScenarioId: this.sandboxInitialScenarioId} : {}),
    }).pipe(Effect.provide(layer)),
  )
})

Then('both scenarios use production command delegation', function (this: MigrationWorld) {
  assert.deepEqual(this.sandboxSessionRuns, ['happy-path', 'guest-user'])
})

Then('the sandbox prompt remains active until the explicit exit', function (this: MigrationWorld) {
  assert.equal(this.sandboxSessionPromptCount, 3)
  assert.equal(this.sandboxSessionLines.at(-1), 'Sandbox session closed.')
})

Then('happy-path is only the first sandbox prompt default', function (this: MigrationWorld) {
  assert.deepEqual(this.sandboxSessionPromptDefaults, ['happy-path'])
})

Then('no sandbox scenario runs without operator selection', function (this: MigrationWorld) {
  assert.deepEqual(this.sandboxSessionRuns, [])
  assert.equal(this.sandboxSessionPromptCount, 1)
})

When('the executed sandbox progress sequence is inspected', function (this: MigrationWorld) {
  assert.ok(this.tuiTrace)
})

Then(
  'the sandbox TUI follows the production dry-run progress sequence',
  function (this: MigrationWorld) {
    assert.deepEqual(
      this.tuiTrace?.snapshots
        .filter(({origin}) => origin === 'progress')
        .map(({state}) => `${state.phase}:${state.status}`),
      ['fetch:running', 'map:running', 'dry-run:running', 'report:completed'],
    )
  },
)

Then('the sandbox TUI explicitly promises no provider writes', function (this: MigrationWorld) {
  assert.equal(this.tuiState?.sandbox, true)
  assert.match(
    renderMigrationDashboardFrame(this.tuiState!, {columns: 120, rows: 30}).join('\n'),
    /SANDBOX DRY RUN • NO PROVIDER WRITES/,
  )
})

When('consecutive live TUI frames are rendered', function (this: MigrationWorld) {
  assert.ok(this.tuiState)
  this.tuiViewports = [
    {columns: 120, rows: 30},
    {columns: 120, rows: 30},
  ]
  this.tuiFrames = [0, 1].map((frameIndex) => [
    ...renderMigrationDashboardFrame(this.tuiState!, {
      columns: 120,
      rows: 30,
      frameIndex,
      elapsedMs: 42_000,
    }),
  ])
})

Then('the TUI frame height remains stable', function (this: MigrationWorld) {
  assert.equal(this.tuiFrames.length, 2)
  assert.equal(this.tuiFrames[0]?.length, this.tuiFrames[1]?.length)
  assert.notDeepEqual(this.tuiFrames[0], this.tuiFrames[1])
})

Then('the TUI progress is explicitly indeterminate', function (this: MigrationWorld) {
  assert.match(this.tuiFrames[0]?.join('\n') ?? '', /INDETERMINATE/)
})

Then(
  'the TUI communicates safety, current stage, and next action',
  function (this: MigrationWorld) {
    const frame = this.tuiFrames[0]?.join('\n') ?? ''
    assert.match(frame, /SANDBOX DRY RUN • NO PROVIDER WRITES/)
    assert.match(frame, /Matching people and teams/)
    assert.match(frame, /NEXT/)
  },
)

When(
  'the TUI is rendered at wide, standard, narrow, and minimal widths',
  function (this: MigrationWorld) {
    assert.ok(this.tuiState)
    this.tuiViewports = [
      {columns: 120, rows: 30},
      {columns: 80, rows: 20},
      {columns: 36, rows: 8},
      {columns: 12, rows: 6},
    ]
    this.tuiFrames = this.tuiViewports.map((viewport) => [
      ...renderMigrationDashboardFrame(this.tuiState!, viewport),
    ])
  },
)

Then('every TUI frame fits its viewport', function (this: MigrationWorld) {
  for (const [index, frame] of this.tuiFrames.entries()) {
    const viewport = this.tuiViewports[index]
    assert.ok(viewport)
    assert.ok(frame.length <= viewport.rows)
    assert.ok(frame.every((line) => visibleWidth(line) <= viewport.columns))
  }
})

Then('the narrow TUI preserves the dry-run safety mode', function (this: MigrationWorld) {
  assert.match(this.tuiFrames[2]?.join('\n') ?? '', /DRY RUN/)
})

When('TUI progress is rendered for a non-interactive terminal', function (this: MigrationWorld) {
  assert.ok(this.tuiState)
  const output = new TuiTestOutput()
  output.isTTY = false
  const dashboard = new TerminalDashboard(this.tuiState, {output})
  dashboard.start()
  dashboard.update({...this.tuiState})
  dashboard.update({...this.tuiState, phase: 'report', message: 'Writing the durable receipt.'})
  dashboard.stop()
  this.tuiOutput = output
})

Then('each changed TUI progress event is emitted once', function (this: MigrationWorld) {
  assert.equal(this.tuiOutput?.writes.length, 2)
})

Then('the plain progress output contains no cursor controls', function (this: MigrationWorld) {
  const output = this.tuiOutput?.writes.join('') ?? ''
  // eslint-disable-next-line no-control-regex -- asserts plain output contains no ESC cursor-control sequences
  assert.doesNotMatch(output, /\u001b/)
  assert.match(output, /\[LIVE\] sandbox-bdd-happy-path/)
})

When('the TUI is rendered with reduced motion', function (this: MigrationWorld) {
  assert.ok(this.tuiState)
  this.tuiFrames = [
    [
      ...renderMigrationDashboardFrame(this.tuiState, {
        columns: 80,
        rows: 20,
        frameIndex: 8,
        reducedMotion: true,
      }),
    ],
  ]
})

Then('the TUI uses a static progress marker', function (this: MigrationWorld) {
  const frame = this.tuiFrames[0]?.join('\n') ?? ''
  assert.match(frame, /◆/)
  assert.doesNotMatch(frame, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
})

Then('the TUI still communicates live status', function (this: MigrationWorld) {
  assert.match(this.tuiFrames[0]?.join('\n') ?? '', /LIVE/)
})

When(
  'the TUI receives multiline and terminal-control provider text',
  function (this: MigrationWorld) {
    assert.ok(this.tuiState)
    this.tuiFrames = [
      [
        ...renderMigrationDashboardFrame(
          {
            ...this.tuiState,
            source: 'contoso\nINJECTED\tTAB',
            message: 'safe\u0007\u001b[2J message',
          },
          {columns: 80, rows: 20},
        ),
      ],
    ]
  },
)

Then(
  'the TUI frame contains no injected physical line or control sequence',
  function (this: MigrationWorld) {
    // eslint-disable-next-line no-control-regex -- asserts no injected physical line or terminal control sequence survives
    assert.ok(this.tuiFrames[0]?.every((line) => !/[\n\t\u0007\u001b]/.test(line)))
  },
)

When('the interactive TUI dashboard starts and stops', function (this: MigrationWorld) {
  assert.ok(this.tuiState)
  const output = new TuiTestOutput()
  const dashboard = new TerminalDashboard(this.tuiState, {
    output,
    reducedMotion: true,
    env: {TERM: 'xterm-256color'},
  })
  dashboard.start()
  dashboard.stop()
  this.tuiOutput = output
})

Then('the alternate screen and cursor are restored', function (this: MigrationWorld) {
  // eslint-disable-next-line no-control-regex -- asserts the alternate-screen enter sequence was written
  assert.match(this.tuiOutput?.writes[0] ?? '', /\u001b\[\?1049h/)
  // eslint-disable-next-line no-control-regex -- asserts the alternate-screen leave sequence was written
  assert.match(this.tuiOutput?.writes.at(-1) ?? '', /\u001b\[\?1049l/)
  // eslint-disable-next-line no-control-regex -- asserts the cursor was restored on teardown
  assert.match(this.tuiOutput?.writes.at(-1) ?? '', /\u001b\[\?25h/)
})

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

Given(
  'the target team is already synchronized by an identity provider',
  function (this: MigrationWorld) {
    this.existingTeamsBySlug.set('platform', {
      slug: 'platform',
      name: TEAM.name,
      privacy: 'closed',
    })
    this.idpManagedTeamSlugs.add('platform')
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
      configurationHash: configurationHash(this.options),
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
