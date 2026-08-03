import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {confirm} from '@inquirer/prompts'
import {Effect, Either, Layer} from 'effect'
import {ApprovalManager} from '../checkpoints/approval.js'
import {CheckpointManager} from '../checkpoints/manager.js'
import {TeamMapper} from '../mappers/team-mapper.js'
import {MarkdownReporter} from '../reporters/markdown.js'
import {AdoService} from '../services/ado.js'
import {GitHubService} from '../services/github.js'
import type {
  CheckpointState,
  FailureLogEntry,
  MappingResult,
  MigrationReport,
  SkippedItem,
} from '../types/index.js'
import {CHECKPOINT_SCHEMA_VERSION} from '../types/index.js'
import {FailureMode} from '../types/failures.js'
import {configurationHash} from '../checkpoints/configuration.js'
import {ConflictResolver} from '../healing/conflict-resolver.js'
import {HealingDispatcher} from '../healing/dispatcher.js'
import {
  MigrationCommandPreflightLiveLayer,
  validateMigrationCommand,
  type MigrationCommandInput,
} from '../effect/migration-command-preflight.js'
import {loadTeamTopology} from '../effect/migration/topology.js'
import {findSandboxScenario, loadSandboxCatalog} from '../sandbox/config.js'
import {
  runSandboxScenario,
  sandboxCheckpointDirectory,
  sandboxDashboardState,
  sandboxReportPath,
  sandboxScenarioRunId,
  sandboxScenarioScope,
} from '../sandbox/scenario-run.js'
import {wasCliFlagProvided} from '../utils/cli-flags.js'
import {
  makeWorkflowWorkerLayer,
  type WorkerMigrationStatus,
  waitForMigration,
  WorkflowWorkerServiceTag,
} from '../workflow/client.js'
import {runSessionInbox} from '../ui/session-inbox.js'
import {renderMigrationCompletion} from '../ui/outcome-confirmation.js'
import {renderCliCommand} from '../ui/command-guidance.js'
import {renderRecoveryGuidance} from '../ui/recovery-guidance.js'
import {renderMigrationStageStatus} from '../ui/migration-stage-status.js'
import {decodePresentationMode, DEFAULT_PRESENTATION_MODE} from '../ui/adaptive-detail.js'
import {
  approvalPrompt,
  migrationApprovalPrompt,
  renderMigrationApprovalContext,
  renderMigrationPlanContext,
} from '../ui/approval-context.js'
import {TerminalMigrationPresentation} from '../ui/migration-presentation.js'
import {supportsInteractiveTui} from '../ui/terminal-dashboard.js'
import {ConfigFormConsole} from '../ui/config-console.js'
import {
  ConfigFormSurfaceTag,
  MAPPING_EXACT,
  MAPPING_PREFIX,
  MAPPING_SUFFIX,
  MAPPING_TOPOLOGY,
  emptyConfigFormValues,
  runConfigForm,
  type ConfigFormResult,
  type ConfigFormState,
} from '../ui/config-form.js'
import {makeTerminalInputLayer} from '../ui/terminal-input.js'

/**
 * Opens the shared migration configuration form on its own alternate screen. The operator supplies
 * every value; the effect only ends when they submit a complete configuration or cancel.
 */
async function collectMigrationConfiguration(initial: ConfigFormState): Promise<ConfigFormResult> {
  const console_ = new ConfigFormConsole()
  console_.open()
  try {
    return await Effect.runPromise(
      runConfigForm(initial).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ConfigFormSurfaceTag, {
              showForm: (fields, focusedIndex, context) =>
                Effect.sync(() => console_.show({fields, focusedIndex, context})),
            }),
            makeTerminalInputLayer(process.stdin),
          ),
        ),
      ),
    )
  } finally {
    console_.close()
  }
}

interface MigrationRunOptions {
  adoOrg: string
  adoProject: string
  githubOrg: string
  apply: boolean
  output?: string
  prefix?: string
  suffix?: string
  yes: boolean
  resume?: string
  runId?: string
}

interface MigrationRunnerDependencies {
  adoService: AdoService
  githubService: GitHubService
  teamMapper: TeamMapper
  checkpointManager: CheckpointManager
  approvalManager: ApprovalManager
  reporter: MarkdownReporter
  dispatcher: HealingDispatcher
  now: () => Date
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function shouldTreatAsNameConflict(error: unknown): boolean {
  return error instanceof Error && /team validation failed/i.test(error.message)
}

function createReportFromState(
  state: CheckpointState,
  dryRun: boolean,
  skippedItems: SkippedItem[],
): MigrationReport {
  return {
    runId: state.runId,
    timestamp: new Date().toISOString(),
    adoOrg: state.adoOrg,
    adoProject: state.adoProject,
    githubOrg: state.githubOrg,
    dryRun,
    mappings: state.mappings,
    edgeCases: state.edgeCases,
    skippedItems,
    failureLog: state.failureLog,
    approvalHistory: state.approvalHistory,
    ...(state.teamPlan ? {teamPlan: state.teamPlan} : {}),
    ...(state.repositoryGrants ? {repositoryGrants: state.repositoryGrants} : {}),
  }
}

export class MigrationRunner {
  private readonly adoService: AdoService
  private readonly githubService: GitHubService
  private readonly teamMapper: TeamMapper
  private readonly checkpointManager: CheckpointManager
  private readonly approvalManager: ApprovalManager
  private readonly reporter: MarkdownReporter
  private readonly dispatcher: HealingDispatcher
  private readonly now: () => Date

  public constructor(deps: MigrationRunnerDependencies) {
    this.adoService = deps.adoService
    this.githubService = deps.githubService
    this.teamMapper = deps.teamMapper
    this.checkpointManager = deps.checkpointManager
    this.approvalManager = deps.approvalManager
    this.reporter = deps.reporter
    this.dispatcher = deps.dispatcher
    this.now = deps.now
  }

  public async run(options: MigrationRunOptions): Promise<{reportPath: string; runId: string}> {
    const startedAt = this.now().getTime()
    const state = await this.getOrCreateState(options)
    const skippedItems: SkippedItem[] = [...state.skippedItems]
    const reportPath =
      options.output ?? path.resolve(process.cwd(), `migration-report-${state.runId}.md`)

    if (state.phase === 'fetch') {
      state.pendingTeams = await this.adoService.getTeams(options.adoProject)
      await this.advancePhase(state, 'map')
    }

    if (state.phase === 'map') {
      const mappings: MappingResult[] = []
      const edgeCases = [...state.edgeCases]
      for (const team of state.pendingTeams) {
        const members = await this.adoService.getTeamMembers(team.projectId, team.id)
        const mapping = await this.teamMapper.mapTeam(team, members)
        mappings.push(mapping)
        edgeCases.push(...mapping.edgeCases)
      }
      state.mappings = mappings
      state.edgeCases = edgeCases
      await this.advancePhase(state, 'dry-run')
    }

    if (state.phase === 'dry-run') {
      const report = createReportFromState(state, !options.apply, skippedItems)
      const markdown = this.reporter.render(report, this.now().getTime() - startedAt)
      await writeFile(reportPath, markdown, 'utf8')
      if (!options.apply) {
        await this.checkpointManager.delete(state.runId)
        return {reportPath, runId: state.runId}
      }
      await this.advancePhase(state, 'create-teams')
    }

    if (state.phase === 'create-teams') {
      const teamNames = state.mappings.map((mapping) => mapping.githubTeam.slug)
      const approved = await this.approvalManager.requestApproval({
        action: `Create ${teamNames.length} teams in ${state.githubOrg}`,
        context: {teamCount: teamNames.length, githubOrg: state.githubOrg},
        displayLines: state.mappings.map(
          (mapping) =>
            `${mapping.githubTeam.slug}: ${JSON.stringify({
              name: mapping.githubTeam.name,
              privacy: mapping.githubTeam.privacy,
              ...(mapping.githubTeam.description
                ? {description: mapping.githubTeam.description}
                : {}),
            })}`,
        ),
        autoApprovable: false,
      })
      state.approvalHistory = this.approvalManager.getHistory()
      await this.checkpointManager.save(state)
      if (!approved) {
        throw new Error('Team creation was not approved by operator.')
      }

      for (const mapping of state.mappings) {
        const slug = mapping.githubTeam.slug
        if (this.checkpointManager.isTeamCompleted(state, slug)) {
          continue
        }

        const created = await this.tryWithHealing(
          state,
          {
            team: mapping.adoTeam.name,
            slug,
            operation: 'create-team',
          },
          async () => {
            const createPayload: Parameters<GitHubService['createTeam']>[0] = {
              slug: mapping.githubTeam.slug,
              name: mapping.githubTeam.name,
              privacy: mapping.githubTeam.privacy,
            }
            if (mapping.githubTeam.description) {
              createPayload.description = mapping.githubTeam.description
            }
            await this.githubService.createTeam(createPayload)
            return true
          },
          (error) =>
            shouldTreatAsNameConflict(error)
              ? FailureMode.TEAM_NAME_CONFLICT
              : this.dispatcher.detectFailureMode(error as Error),
          {
            adoName: mapping.githubTeam.name,
            existingSlug: mapping.githubTeam.slug,
          },
        )
        if (!created) {
          skippedItems.push({
            type: 'team',
            name: mapping.githubTeam.name,
            reason: 'Skipped by healing strategy',
          })
          state.skippedItems = [...skippedItems]
          await this.checkpointManager.save(state)
          continue
        }

        this.checkpointManager.markTeamCompleted(state, slug)
        state.approvalHistory = this.approvalManager.getHistory()
        await this.checkpointManager.save(state)
      }
      await this.advancePhase(state, 'assign-members')
    }

    if (state.phase === 'assign-members') {
      const eligibleMembers = state.mappings.flatMap((mapping) =>
        mapping.memberMappings
          .filter((member) => member.mapped && member.githubUser)
          .map((member) => ({
            slug: mapping.githubTeam.slug,
            login: member.githubUser?.login ?? '',
          })),
      )
      const approved = await this.approvalManager.requestApproval({
        action: `Add ${eligibleMembers.length} members across ${state.mappings.length} teams`,
        context: {
          teamCount: state.mappings.length,
          memberCount: eligibleMembers.length,
        },
        displayLines: eligibleMembers.map(({slug, login}) => `${slug}:${login}`),
        autoApprovable: false,
      })
      state.approvalHistory = this.approvalManager.getHistory()
      await this.checkpointManager.save(state)
      if (!approved) {
        throw new Error('Member assignment was not approved by operator.')
      }

      for (const mapping of state.mappings) {
        for (const member of mapping.memberMappings) {
          const login = member.githubUser?.login
          if (!member.mapped || !login) {
            continue
          }
          if (this.checkpointManager.isMemberCompleted(state, mapping.githubTeam.slug, login)) {
            continue
          }

          const added = await this.tryWithHealing(
            state,
            {
              teamSlug: mapping.githubTeam.slug,
              login,
              operation: 'assign-member',
            },
            async () => {
              await this.githubService.addTeamMember(mapping.githubTeam.slug, login)
              return true
            },
            (error) => this.dispatcher.detectFailureMode(error as Error),
          )
          if (!added) {
            skippedItems.push({
              type: 'member',
              name: `${mapping.githubTeam.slug}:${login}`,
              reason: 'Skipped by healing strategy',
            })
            state.skippedItems = [...skippedItems]
            await this.checkpointManager.save(state)
            continue
          }

          this.checkpointManager.markMemberCompleted(state, mapping.githubTeam.slug, login)
          await this.checkpointManager.save(state)
        }
      }
      await this.advancePhase(state, 'report')
    }

    if (state.phase === 'report') {
      const report = createReportFromState(state, false, skippedItems)
      const markdown = this.reporter.render(report, this.now().getTime() - startedAt)
      await writeFile(reportPath, markdown, 'utf8')
      await this.checkpointManager.delete(state.runId)
    }

    return {reportPath, runId: state.runId}
  }

  private async getOrCreateState(options: MigrationRunOptions): Promise<CheckpointState> {
    if (options.resume) {
      const existing = await this.checkpointManager.load(options.resume)
      if (!existing) {
        throw new Error(`Checkpoint ${options.resume} was not found.`)
      }
      if (
        existing.adoOrg !== options.adoOrg ||
        existing.adoProject !== options.adoProject ||
        existing.githubOrg !== options.githubOrg ||
        existing.migrationConfig.apply !== options.apply ||
        existing.migrationConfig.prefix !== (options.prefix ?? '') ||
        existing.migrationConfig.suffix !== (options.suffix ?? '')
      ) {
        throw new Error(
          `Checkpoint ${options.resume} is incompatible with the requested migration scope.`,
        )
      }
      return existing
    }

    const state: CheckpointState = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      configurationHash: configurationHash(options),
      runId: options.runId ?? randomUUID(),
      timestamp: this.now().toISOString(),
      adoOrg: options.adoOrg,
      adoProject: options.adoProject,
      githubOrg: options.githubOrg,
      migrationConfig: {
        apply: options.apply,
        prefix: options.prefix ?? '',
        suffix: options.suffix ?? '',
        topologyDigest: '',
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
    await this.checkpointManager.save(state)
    return state
  }

  private async advancePhase(
    state: CheckpointState,
    phase: CheckpointState['phase'],
  ): Promise<void> {
    state.phase = phase
    state.timestamp = this.now().toISOString()
    state.approvalHistory = this.approvalManager.getHistory()
    await this.checkpointManager.save(state)
  }

  private async tryWithHealing<T>(
    state: CheckpointState,
    context: Record<string, unknown>,
    fn: () => Promise<T>,
    modeSelector: (error: unknown) => FailureMode,
    conflictInput?: {adoName: string; existingSlug: string},
  ): Promise<T | null> {
    try {
      return await fn()
    } catch (error) {
      const mode = modeSelector(error)
      const dispatchRequest: Parameters<HealingDispatcher['dispatch']>[0] = {
        error: error instanceof Error ? error : new Error(String(error)),
        mode,
        context,
        approval: this.approvalManager,
      }
      if (conflictInput) {
        dispatchRequest.conflictResolver = new ConflictResolver()
        dispatchRequest.conflictInput = conflictInput
      }
      const healing = await this.dispatcher.dispatch(dispatchRequest)

      const failureLog: FailureLogEntry = {
        failureMode: mode,
        error: summarizeError(error),
        healingAction: healing.action.description,
        resolved: healing.healed,
      }
      if (healing.userApproved !== undefined) {
        failureLog.userApproved = healing.userApproved
      }
      state.failureLog.push(failureLog)
      state.approvalHistory = this.approvalManager.getHistory()
      await this.checkpointManager.save(state)

      if (healing.retryRequest) {
        return this.tryWithHealing(state, context, fn, modeSelector, conflictInput)
      }
      if (healing.skipItem) {
        return null
      }
      if (healing.abortMigration) {
        throw error
      }
      return null
    }
  }
}

export default class Migrate extends Command {
  static override description = 'Migrate Azure DevOps project teams to GitHub organization teams'

  static override examples = [
    {
      description: 'Preview a complete live scope and wait for its dry-run report',
      command:
        '<%= config.bin %> <%= command.id %> --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso --foreground',
    },
    {
      description: 'Use task-shaped source and target aliases for the same live scope',
      command:
        '<%= config.bin %> <%= command.id %> --source-org https://dev.azure.com/contoso --source-project Platform --target-org contoso --foreground',
    },
    {
      description: 'Resume a retained durable migration without reconstructing its scope',
      command: '<%= config.bin %> <%= command.id %> --resume <run-id> --foreground',
    },
    {
      description: 'Preview exact topology names without prefix or suffix modifiers',
      command:
        '<%= config.bin %> <%= command.id %> --ado-org https://dev.azure.com/contoso --ado-project Platform --github-org contoso --team-topology ./teams.yaml',
    },
    {
      description: 'Run a credential-free sandbox scenario',
      command: '<%= config.bin %> <%= command.id %> --sandbox happy-path',
    },
  ]

  static override flags = {
    'ado-org': Flags.string({
      aliases: ['source-org'],
      description: 'Azure DevOps organization URL; provide with the other live-scope flags',
      helpGroup: 'LIVE SCOPE (REQUIRED TOGETHER)',
      required: false,
    }),
    'ado-project': Flags.string({
      aliases: ['source-project'],
      description: 'Azure DevOps project name; provide with the other live-scope flags',
      helpGroup: 'LIVE SCOPE (REQUIRED TOGETHER)',
      required: false,
    }),
    'github-org': Flags.string({
      aliases: ['target-org'],
      description: 'GitHub target organization; provide with the other live-scope flags',
      helpGroup: 'LIVE SCOPE (REQUIRED TOGETHER)',
      required: false,
    }),
    apply: Flags.boolean({
      description: 'Execute writes (default is dry-run)',
      default: false,
      helpGroup: 'EXECUTION',
    }),
    output: Flags.string({
      description: 'Path for Markdown report (default: ./migration-report-<runId>.md)',
      helpGroup: 'PRESENTATION',
      required: false,
    }),
    detail: Flags.string({
      description: 'Presentation detail: guided orientation or compact scanning',
      helpGroup: 'PRESENTATION',
      options: ['guided', 'compact'],
      default: DEFAULT_PRESENTATION_MODE,
    }),
    prefix: Flags.string({
      description: 'Team name prefix; cannot be combined with --team-topology',
      helpGroup: 'NAMING AND TOPOLOGY',
      required: false,
    }),
    suffix: Flags.string({
      description: 'Team name suffix; cannot be combined with --team-topology',
      helpGroup: 'NAMING AND TOPOLOGY',
      required: false,
    }),
    yes: Flags.boolean({
      description: 'Use predefined approval decisions in sandbox mode',
      default: false,
      helpGroup: 'SANDBOX (SIMULATED PROVIDERS)',
    }),
    resume: Flags.string({
      description: 'Resume a retained run ID; cannot be combined with --fresh or --sandbox',
      helpGroup: 'RECOVERY',
      required: false,
    }),
    fresh: Flags.boolean({
      description: 'Start a new session instead of reopening the latest compatible session',
      default: false,
      helpGroup: 'RECOVERY',
    }),
    foreground: Flags.boolean({
      description: 'Wait for the durable migration to complete',
      default: false,
      helpGroup: 'EXECUTION',
    }),
    tui: Flags.boolean({
      description: 'Use the animated interactive terminal dashboard when supported',
      default: true,
      allowNo: true,
    }),
    sessions: Flags.boolean({
      description: 'Open the parallel migration session and elicitation inbox',
      default: false,
      helpGroup: 'RECOVERY',
    }),
    concurrency: Flags.integer({
      description: 'Maximum concurrent mapping requests; positive integer (default: 4)',
      default: 4,
      helpGroup: 'EXECUTION',
    }),
    'team-topology': Flags.string({
      description: 'YAML or JSON hierarchy plan with exact names; excludes --prefix and --suffix',
      helpGroup: 'NAMING AND TOPOLOGY',
      required: false,
    }),
    'worker-url': Flags.string({
      description: 'Durable migration worker URL',
      default: process.env.WORKFLOW_BASE_URL ?? 'http://127.0.0.1:7331',
      helpGroup: 'WORKER',
    }),
    sandbox: Flags.string({
      description: 'Run a configured scenario with simulated ADO, Entra, and GitHub boundaries',
      helpGroup: 'SANDBOX (SIMULATED PROVIDERS)',
      required: false,
    }),
    'sandbox-config': Flags.string({
      description: 'Scenario YAML path; requires --sandbox or --list-sandbox-scenarios',
      helpGroup: 'SANDBOX (SIMULATED PROVIDERS)',
      required: false,
    }),
    'list-sandbox-scenarios': Flags.boolean({
      description: 'List scenarios from the sandbox config and exit',
      default: false,
      helpGroup: 'SANDBOX (SIMULATED PROVIDERS)',
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Migrate)
    const preflightInput: MigrationCommandInput = {
      apply: flags.apply,
      detail: flags.detail,
      yes: flags.yes,
      fresh: flags.fresh,
      foreground: flags.foreground,
      sessions: flags.sessions,
      tui: flags.tui,
      concurrency: flags.concurrency,
      workerUrl: flags['worker-url'],
      listSandboxScenarios: flags['list-sandbox-scenarios'],
      ...(flags['ado-org'] ? {adoOrg: flags['ado-org']} : {}),
      ...(flags['ado-project'] ? {adoProject: flags['ado-project']} : {}),
      ...(flags['github-org'] ? {githubOrg: flags['github-org']} : {}),
      ...(flags.output ? {output: flags.output} : {}),
      ...(flags.prefix ? {prefix: flags.prefix} : {}),
      ...(flags.suffix ? {suffix: flags.suffix} : {}),
      ...(flags.resume ? {resume: flags.resume} : {}),
      ...(flags['team-topology'] ? {teamTopology: flags['team-topology']} : {}),
      ...(flags.sandbox ? {sandbox: flags.sandbox} : {}),
      ...(flags['sandbox-config'] ? {sandboxConfig: flags['sandbox-config']} : {}),
    }
    const runPreflight = async (input: MigrationCommandInput) => {
      const result = await Effect.runPromise(
        Effect.either(
          validateMigrationCommand(input).pipe(Effect.provide(MigrationCommandPreflightLiveLayer)),
        ),
      )
      if (Either.isLeft(result)) {
        this.error(renderRecoveryGuidance(result.left, this.argv))
      }
      return result.right
    }
    await runPreflight(preflightInput)
    const presentationMode = decodePresentationMode(flags.detail)

    if (flags['list-sandbox-scenarios']) {
      const loaded = await Effect.runPromise(loadSandboxCatalog(flags['sandbox-config']))
      for (const scenario of loaded.catalog.scenarios) {
        this.log(`${scenario.id.padEnd(24)} ${scenario.mode.padEnd(7)} ${scenario.title}`)
      }
      return
    }

    if (flags.sandbox) {
      const loaded = await Effect.runPromise(loadSandboxCatalog(flags['sandbox-config']))
      const scenario = await Effect.runPromise(findSandboxScenario(loaded.catalog, flags.sandbox))
      await runPreflight({...preflightInput, scenarioMode: scenario.mode})

      const runId = sandboxScenarioRunId(scenario.id)
      const output = flags.output ?? sandboxReportPath(scenario.id)
      const scope = sandboxScenarioScope(scenario, {
        ...(flags['ado-org'] ? {adoOrg: flags['ado-org']} : {}),
        ...(flags['ado-project'] ? {adoProject: flags['ado-project']} : {}),
        ...(flags['github-org'] ? {githubOrg: flags['github-org']} : {}),
      })
      const presentation = new TerminalMigrationPresentation(
        sandboxDashboardState({runId, scope, apply: flags.apply}),
        {enabled: flags.tui},
      )

      this.log(chalk.yellow(`SANDBOX: ${scenario.id} — no provider writes will be performed.`))
      const outcome = await Effect.runPromise(
        runSandboxScenario({
          scenario,
          configDigest: loaded.digest,
          presentation,
          runId,
          scope,
          output,
          checkpointDirectory: sandboxCheckpointDirectory(scenario.id, runId),
          apply: flags.apply,
          yes: flags.yes,
          concurrency: flags.concurrency,
          ...(flags.prefix ? {prefix: flags.prefix} : {}),
          ...(flags.suffix ? {suffix: flags.suffix} : {}),
          writeLine: (line) => this.log(chalk.cyan(line)),
          confirmApproval: async (request) =>
            confirm({message: approvalPrompt(request), default: false}),
        }),
      )

      if (outcome._tag === 'expected-failure') {
        this.log(chalk.yellow(`Scenario reached its expected failure: ${outcome.message}`))
        return
      }
      for (const line of renderMigrationCompletion({
        runId: outcome.runId,
        reportPath: outcome.reportPath,
        apply: flags.apply,
        sandboxScenario: scenario.id,
      })) {
        this.log(chalk.green(line))
      }
      return
    }

    const applyWasProvided = wasCliFlagProvided(this.argv, '--apply')
    const concurrencyWasProvided = wasCliFlagProvided(this.argv, '--concurrency')
    const hasExplicitScope = Boolean(
      flags['ado-org'] || flags['ado-project'] || flags['github-org'],
    )
    const canConfigureInteractively =
      flags.foreground &&
      flags.tui &&
      process.stdin.isTTY === true &&
      supportsInteractiveTui(process.stdout)

    const apiToken = process.env.WORKFLOW_API_TOKEN
    if (!apiToken || apiToken.length < 32) {
      throw new Error('WORKFLOW_API_TOKEN must contain at least 32 characters.')
    }
    const loadedTopology = flags['team-topology']
      ? await Effect.runPromise(loadTeamTopology(flags['team-topology']))
      : undefined
    const workerLayer = makeWorkflowWorkerLayer(flags['worker-url'], apiToken)
    const worker = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* WorkflowWorkerServiceTag
      }).pipe(Effect.provide(workerLayer)),
    )
    const existingStatus = flags.resume
      ? await Effect.runPromise(worker.status(flags.resume))
      : !flags.fresh && !hasExplicitScope
        ? await Effect.runPromise(worker.latest)
        : null
    const session = existingStatus?.migration ?? null

    if (
      !flags.fresh &&
      !hasExplicitScope &&
      !flags.resume &&
      !session &&
      !canConfigureInteractively
    ) {
      this.error(
        'No durable migration session was found. Provide --ado-org, --ado-project, and --github-org to start one.',
      )
    }

    let adoOrg = flags['ado-org'] ?? session?.adoOrg
    let adoProject = flags['ado-project'] ?? session?.adoProject
    let githubOrg = flags['github-org'] ?? session?.githubOrg
    let apply = applyWasProvided ? flags.apply : (session?.apply ?? false)
    let prefix = flags.prefix
    let suffix = flags.suffix
    let output = flags.output ?? session?.output
    let concurrency = concurrencyWasProvided
      ? flags.concurrency
      : (session?.concurrency ?? flags.concurrency)
    let topology = loadedTopology
      ? {config: loadedTopology.config, digest: loadedTopology.digest}
      : undefined
    const missingScope = [
      !adoOrg ? '--ado-org' : '',
      !adoProject ? '--ado-project' : '',
      !githubOrg ? '--github-org' : '',
    ].filter(Boolean)

    if (missingScope.length > 0) {
      if (!canConfigureInteractively) {
        this.error(`Live migration requires: ${missingScope.join(', ')}`)
      }
      const mapping = flags['team-topology']
        ? MAPPING_TOPOLOGY
        : prefix
          ? MAPPING_PREFIX
          : suffix
            ? MAPPING_SUFFIX
            : MAPPING_EXACT
      const result = await collectMigrationConfiguration({
        values: {
          ...emptyConfigFormValues(),
          adoOrg: adoOrg ?? '',
          adoProject: adoProject ?? '',
          githubOrg: githubOrg ?? '',
          mapping,
          mappingValue: flags['team-topology'] ?? prefix ?? suffix ?? '',
          execution: apply ? 'apply' : 'dry-run',
          concurrency: String(concurrency),
          output: output ?? '',
        },
        focusedIndex: 0,
        showProblems: false,
        context: {
          environment: 'live',
          title: 'Migration configuration',
          allowTopology: true,
        },
      })
      if (result._tag === 'cancelled') {
        this.log(
          chalk.yellow('Migration configuration cancelled. Nothing was planned and nothing ran.'),
        )
        return
      }
      const selection = result.selection
      adoOrg = selection.adoOrg
      adoProject = selection.adoProject
      githubOrg = selection.githubOrg
      apply = selection.apply
      concurrency = selection.concurrency
      prefix = selection.prefix
      suffix = selection.suffix
      output = selection.output ?? output
      if (selection.teamTopology) {
        const chosenTopology = await Effect.runPromise(loadTeamTopology(selection.teamTopology))
        topology = {config: chosenTopology.config, digest: chosenTopology.digest}
      }
    }

    if (!adoOrg || !adoProject || !githubOrg) {
      return
    }

    const request = {
      runId: session?.runId ?? flags.resume ?? randomUUID(),
      adoOrg,
      adoProject,
      githubOrg,
      apply,
      concurrency,
      ...(prefix ? {prefix} : {}),
      ...(suffix ? {suffix} : {}),
      ...(topology ? {topology} : {}),
    }
    const runId = request.runId
    const presentation = new TerminalMigrationPresentation(
      {
        runId,
        source: `${adoOrg}/${adoProject}`,
        target: githubOrg,
        apply,
        phase: session?.phase ?? 'fetch',
        status: 'running',
        message: session ? 'Refreshing durable worker state.' : 'Starting durable orchestration.',
        ...(session?.updatedAt ? {updatedAt: session.updatedAt} : {}),
      },
      {enabled: flags.tui && flags.foreground},
    )
    const waitWithDashboard = async (
      ready: Parameters<typeof waitForMigration>[1],
    ): Promise<WorkerMigrationStatus> => {
      presentation.start()
      try {
        return await Effect.runPromise(
          waitForMigration(runId, ready, 3600, (status) => {
            const workflowStatus = status.workflowStatus.toLowerCase()
            presentation.update({
              phase: status.migration?.phase ?? 'fetch',
              status:
                workflowStatus === 'blocked' ||
                (status.migration?.blockingElicitations.length ?? 0) > 0
                  ? 'blocked'
                  : workflowStatus === 'completed'
                    ? 'completed'
                    : ['failed', 'cancelled'].includes(workflowStatus)
                      ? 'failed'
                      : ['queued', 'pending'].includes(workflowStatus)
                        ? 'queued'
                        : 'running',
              message:
                status.migration?.blockingElicitations.length === 1
                  ? 'One operator decision is required before work can continue.'
                  : status.migration?.blockingElicitations.length
                    ? `${status.migration.blockingElicitations.length} operator decisions are required.`
                    : 'Durable worker checkpoint received.',
              ...(status.migration?.updatedAt ? {updatedAt: status.migration.updatedAt} : {}),
            })
          }).pipe(Effect.provide(workerLayer)),
        )
      } finally {
        presentation.stop()
      }
    }

    let planned = existingStatus
    if (!existingStatus) {
      this.log(chalk.cyan(`Starting durable migration. Run ID: ${runId}`))
      const started = await Effect.runPromise(worker.start(request))
      if (started.runId !== runId) {
        throw new Error(
          `Workflow worker changed migration run ID from ${runId} to ${started.runId}.`,
        )
      }
      this.log(chalk.cyan(`Durable migration queued. Run ID: ${runId}`))
      if (!flags.foreground) {
        for (const line of renderMigrationStageStatus(
          {
            runId,
            phase: 'fetch',
            workflowStatus: started.status,
          },
          presentationMode,
        )) {
          this.log(line)
        }
        this.log('Reopen the CLI at any time to view progress or continue approval.')
        return
      }
    } else {
      this.log(chalk.bold(`Reopened migration session ${runId}`))
    }

    if (!planned?.migration || ['fetch', 'map'].includes(planned.migration.phase)) {
      if (!flags.foreground) {
        for (const line of renderMigrationStageStatus(
          {
            runId,
            phase: planned?.migration?.phase ?? 'fetch',
            workflowStatus: planned?.workflowStatus ?? 'running',
            updatedAt: planned?.migration?.updatedAt,
            blockingCount: planned?.migration?.blockingElicitations.length,
          },
          presentationMode,
        )) {
          this.log(line)
        }
        return
      }
      planned = await waitWithDashboard(
        (status) => status.migration !== null && !['fetch', 'map'].includes(status.migration.phase),
      )
      if (flags.sessions) {
        await runSessionInbox({
          worker,
          log: (message) => this.log(message),
          operator: process.env.USER ?? process.env.USERNAME ?? 'interactive-operator',
        })
        return
      }
    }
    const plan = planned.migration?.plan
    if (!plan) {
      throw new Error(`Migration ${runId} completed planning without a plan.`)
    }

    const reportPath = output ?? path.resolve(process.cwd(), `migration-report-${runId}.md`)
    const existingApproval = apply
      ? planned.migration?.approvals.find((approval) => approval.action === 'Apply migration')
      : undefined
    const decisionContext =
      apply && !existingApproval
        ? renderMigrationApprovalContext({
            runId,
            reportPath,
            plan,
            presentationMode,
          })
        : renderMigrationPlanContext({
            runId,
            reportPath,
            plan,
            presentationMode,
          })
    for (const line of decisionContext) {
      this.log(apply && !existingApproval ? chalk.cyan(line) : line)
    }

    if (apply) {
      if (existingApproval?.approved === false) {
        this.log(chalk.yellow(`Migration ${runId} was already rejected.`))
        return
      }
      if (!existingApproval) {
        const approved = await confirm({
          message: migrationApprovalPrompt(),
          default: false,
        })
        await Effect.runPromise(
          worker.approve(runId, {
            approved,
            approvedBy: process.env.USER ?? process.env.USERNAME ?? 'interactive-operator',
          }),
        )
        if (!approved) {
          this.log(chalk.yellow(`Migration ${runId} was rejected.`))
          return
        }
        if (!flags.foreground) {
          this.log(chalk.green('Migration approved and continuing in the background.'))
          for (const line of renderMigrationStageStatus(
            {
              runId,
              phase: 'create-teams',
              workflowStatus: 'running',
              updatedAt: planned.migration?.updatedAt,
            },
            presentationMode,
          )) {
            this.log(line)
          }
          return
        }
      }
    }

    if ((planned.migration?.blockingElicitations.length ?? 0) > 0) {
      for (const line of renderMigrationStageStatus(
        {
          runId,
          phase: planned.migration?.phase ?? 'dry-run',
          workflowStatus: 'blocked',
          updatedAt: planned.migration?.updatedAt,
          blockingCount: planned.migration?.blockingElicitations.length,
        },
        presentationMode,
      )) {
        this.log(chalk.yellow(line))
      }
      this.log('Run this command with --sessions to switch to and resolve it.')
      return
    }

    if (planned.workflowStatus.toLowerCase() !== 'completed') {
      if (!flags.foreground) {
        for (const line of renderMigrationStageStatus(
          {
            runId,
            phase: planned.migration?.phase ?? 'dry-run',
            workflowStatus: planned.workflowStatus,
            updatedAt: planned.migration?.updatedAt,
            blockingCount: planned.migration?.blockingElicitations.length,
          },
          presentationMode,
        )) {
          this.log(chalk.cyan(line))
        }
        return
      }
      const completed = await waitWithDashboard(
        (status) => status.workflowStatus.toLowerCase() === 'completed',
      )
      if (
        completed.workflowStatus.toLowerCase() === 'blocked' ||
        (completed.migration?.blockingElicitations.length ?? 0) > 0
      ) {
        this.log(
          chalk.yellow(
            `Migration ${runId} is blocked. Run this command with --sessions to resolve its elicitation.`,
          ),
        )
        return
      }
    }
    const report = await Effect.runPromise(worker.report(runId))
    await writeFile(reportPath, report, 'utf8')

    for (const line of renderMigrationCompletion({
      runId,
      reportPath,
      apply,
      nextCommands: apply
        ? ['a2g sessions', 'a2g']
        : [
            renderCliCommand([
              'ado-to-github-teams',
              'migrate',
              '--ado-org',
              adoOrg,
              '--ado-project',
              adoProject,
              '--github-org',
              githubOrg,
              ...(flags['team-topology']
                ? ['--team-topology', flags['team-topology']]
                : [
                    ...(prefix ? ['--prefix', prefix] : []),
                    ...(suffix ? ['--suffix', suffix] : []),
                  ]),
              '--apply',
              '--foreground',
            ]),
          ],
    })) {
      this.log(chalk.green(line))
    }
  }
}
