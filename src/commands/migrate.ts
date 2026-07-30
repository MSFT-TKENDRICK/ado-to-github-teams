import {randomUUID} from 'node:crypto'
import {rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {confirm} from '@inquirer/prompts'
import {Effect, Layer} from 'effect'
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
import {makeCheckpointLayer} from '../effect/layers.js'
import {runEffectMigration} from '../effect/migration.js'
import {ValidationFailure} from '../effect/errors.js'
import {loadTeamTopology} from '../effect/migration/topology.js'
import {findSandboxScenario, loadSandboxCatalog} from '../sandbox/config.js'
import {
  makeSandboxApprovalLayer,
  makeSandboxBoundaryLayers,
  makeSandboxReportWriterLayer,
} from '../sandbox/layers.js'
import {SandboxRuntime} from '../sandbox/runtime.js'
import {wasCliFlagProvided} from '../utils/cli-flags.js'
import {
  makeWorkflowWorkerLayer,
  waitForMigration,
  WorkflowWorkerServiceTag,
} from '../workflow/client.js'
import {runSessionInbox} from '../ui/session-inbox.js'
import {renderOutcomeConfirmation} from '../ui/outcome-confirmation.js'
import {renderMigrationStageStatus} from '../ui/migration-stage-status.js'
import {
  approvalPrompt,
  migrationApprovalPrompt,
  renderApprovalRequestContext,
  renderMigrationApprovalContext,
  renderMigrationPlanContext,
} from '../ui/approval-context.js'

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

  static override flags = {
    'ado-org': Flags.string({
      description: 'Azure DevOps organization URL',
      required: false,
    }),
    'ado-project': Flags.string({
      description: 'Azure DevOps project name',
      required: false,
    }),
    'github-org': Flags.string({
      description: 'GitHub organization name',
      required: false,
    }),
    apply: Flags.boolean({
      description: 'Execute writes (default is dry-run)',
      default: false,
    }),
    output: Flags.string({
      description: 'Path for Markdown report (default: ./migration-report-<runId>.md)',
      required: false,
    }),
    prefix: Flags.string({
      description: 'Optional team name prefix',
      required: false,
    }),
    suffix: Flags.string({
      description: 'Optional team name suffix',
      required: false,
    }),
    yes: Flags.boolean({
      description: 'Auto-approve non-destructive actions in CI',
      default: false,
    }),
    resume: Flags.string({
      description: 'Resume from checkpoint run ID',
      required: false,
    }),
    fresh: Flags.boolean({
      description: 'Start a new session instead of reopening the latest compatible session',
      default: false,
    }),
    foreground: Flags.boolean({
      description: 'Wait for the durable migration to complete',
      default: false,
    }),
    sessions: Flags.boolean({
      description: 'Open the parallel migration session and elicitation inbox',
      default: false,
    }),
    concurrency: Flags.integer({
      description: 'Maximum concurrent mapping requests',
      default: 4,
    }),
    'team-topology': Flags.string({
      description: 'YAML or JSON OU/project/repository team hierarchy plan',
      required: false,
    }),
    'worker-url': Flags.string({
      description: 'Durable migration worker URL',
      default: process.env.WORKFLOW_BASE_URL ?? 'http://127.0.0.1:7331',
    }),
    sandbox: Flags.string({
      description: 'Run a configured scenario with simulated ADO, Entra, and GitHub boundaries',
      required: false,
    }),
    'sandbox-config': Flags.string({
      description: 'Path to an editable sandbox scenario YAML file',
      required: false,
    }),
    'list-sandbox-scenarios': Flags.boolean({
      description: 'List scenarios from the sandbox config and exit',
      default: false,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Migrate)
    if (flags['sandbox-config'] && !flags.sandbox && !flags['list-sandbox-scenarios']) {
      this.error('--sandbox-config requires --sandbox or --list-sandbox-scenarios')
    }
    if (flags['team-topology'] && (flags.prefix || flags.suffix)) {
      this.error(
        '--team-topology cannot be combined with --prefix or --suffix; topology names are exact',
      )
    }
    if (flags.fresh && flags.resume) {
      this.error('--fresh cannot be combined with --resume')
    }

    if (flags['list-sandbox-scenarios']) {
      const loaded = await Effect.runPromise(loadSandboxCatalog(flags['sandbox-config']))
      for (const scenario of loaded.catalog.scenarios) {
        this.log(`${scenario.id.padEnd(24)} ${scenario.mode.padEnd(7)} ${scenario.title}`)
      }
      return
    }

    if (flags.sandbox) {
      if (flags['team-topology']) {
        this.error('Sandbox scenarios do not currently accept --team-topology')
      }
      if (flags.resume) {
        this.error(
          'Sandbox scenarios do not support --resume; start the scenario from its fixture state',
        )
      }
      const loaded = await Effect.runPromise(loadSandboxCatalog(flags['sandbox-config']))
      const scenario = await Effect.runPromise(findSandboxScenario(loaded.catalog, flags.sandbox))
      if (scenario.mode === 'apply' && !flags.apply) {
        this.error(
          `Sandbox scenario "${scenario.id}" requires --apply (provider writes remain simulated)`,
        )
      }
      if (scenario.mode === 'dry-run' && flags.apply) {
        this.error(
          `Sandbox scenario "${scenario.id}" is a dry-run scenario and does not accept --apply`,
        )
      }

      const runtime = new SandboxRuntime(scenario)
      const approvalDecider = flags.yes
        ? undefined
        : async (request: Parameters<SandboxRuntime['requestApproval']>[0]) => {
            for (const line of renderApprovalRequestContext(request)) {
              this.log(chalk.cyan(line))
            }
            return confirm({
              message: approvalPrompt(request),
              default: false,
            })
          }
      const checkpointDirectory = path.join(
        process.cwd(),
        '.ado-github-teams',
        'sandbox-checkpoints',
        scenario.id,
      )
      const runtimeLayer = Layer.mergeAll(
        makeSandboxBoundaryLayers(runtime),
        makeSandboxApprovalLayer(runtime, approvalDecider),
        makeCheckpointLayer(checkpointDirectory),
        makeSandboxReportWriterLayer(runtime, loaded.digest),
      )
      const output = flags.output ?? path.resolve(process.cwd(), `sandbox-report-${scenario.id}.md`)
      const migration = runEffectMigration({
        adoOrg: flags['ado-org'] ?? scenario.scope.adoOrg,
        adoProject: flags['ado-project'] ?? scenario.scope.adoProject,
        githubOrg: flags['github-org'] ?? scenario.scope.githubOrg,
        apply: flags.apply,
        output,
        concurrency: Math.max(1, flags.concurrency),
        autoResume: false,
        ...(flags.prefix ? {prefix: flags.prefix} : {}),
        ...(flags.suffix ? {suffix: flags.suffix} : {}),
      }).pipe(Effect.provide(runtimeLayer), Effect.either)

      this.log(chalk.yellow(`SANDBOX: ${scenario.id} — no provider writes will be performed.`))
      const result = await Effect.runPromise(migration)
      await Effect.runPromise(runtime.verify())
      if (result._tag === 'Left') {
        if (
          scenario.expected.outcome === 'failure' &&
          result.left._tag === scenario.expected.failureType &&
          'service' in result.left &&
          result.left.service === scenario.expected.failureService &&
          result.left.message.includes(scenario.expected.failureIncludes ?? '')
        ) {
          await rm(checkpointDirectory, {recursive: true, force: true})
          this.log(chalk.yellow(`Scenario reached its expected failure: ${result.left.message}`))
          return
        }
        throw result.left
      }
      if (scenario.expected.outcome === 'failure') {
        throw new ValidationFailure({
          service: 'sandbox',
          message: `Scenario ${scenario.id} succeeded but expected a failure`,
        })
      }
      for (const line of renderOutcomeConfirmation({
        title: 'Sandbox scenario complete.',
        reference: result.right.runId,
        result:
          'Production orchestration completed with simulated provider boundaries and no provider writes.',
        record: result.right.reportPath,
        nextStep:
          'Review the report, especially edge cases, approvals, and the boundary transcript.',
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

    const apiToken = process.env.WORKFLOW_API_TOKEN
    if (!apiToken || apiToken.length < 32) {
      throw new Error('WORKFLOW_API_TOKEN must contain at least 32 characters.')
    }
    const loadedTopology = flags['team-topology']
      ? await Effect.runPromise(loadTeamTopology(flags['team-topology']))
      : undefined
    const topology = loadedTopology
      ? {config: loadedTopology.config, digest: loadedTopology.digest}
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

    if (!flags.fresh && !hasExplicitScope && !flags.resume && !session) {
      this.error(
        'No durable migration session was found. Provide --ado-org, --ado-project, and --github-org to start one.',
      )
    }

    const adoOrg = flags['ado-org'] ?? session?.adoOrg
    const adoProject = flags['ado-project'] ?? session?.adoProject
    const githubOrg = flags['github-org'] ?? session?.githubOrg
    const apply = applyWasProvided ? flags.apply : (session?.apply ?? false)
    const prefix = flags.prefix
    const suffix = flags.suffix
    const output = flags.output ?? session?.output
    const concurrency = Math.max(
      1,
      concurrencyWasProvided ? flags.concurrency : (session?.concurrency ?? flags.concurrency),
    )
    const missingScope = [
      !adoOrg ? '--ado-org' : '',
      !adoProject ? '--ado-project' : '',
      !githubOrg ? '--github-org' : '',
    ].filter(Boolean)
    if (missingScope.length > 0) {
      this.error(`Live migration requires: ${missingScope.join(', ')}`)
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
        for (const line of renderMigrationStageStatus({
          runId,
          phase: 'fetch',
          workflowStatus: started.status,
        })) {
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
        for (const line of renderMigrationStageStatus({
          runId,
          phase: planned?.migration?.phase ?? 'fetch',
          workflowStatus: planned?.workflowStatus ?? 'running',
          updatedAt: planned?.migration?.updatedAt,
          blockingCount: planned?.migration?.blockingElicitations.length,
        })) {
          this.log(line)
        }
        return
      }
      planned = await Effect.runPromise(
        waitForMigration(
          runId,
          (status) =>
            status.migration !== null && !['fetch', 'map'].includes(status.migration.phase),
        ).pipe(Effect.provide(workerLayer)),
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
        ? renderMigrationApprovalContext({runId, reportPath, plan})
        : renderMigrationPlanContext({runId, reportPath, plan})
    for (const line of decisionContext) {
      this.log(apply && !existingApproval ? chalk.cyan(line) : line)
    }

    if (apply) {
      if (existingApproval?.approved === false) {
        this.log(chalk.yellow(`Migration ${runId} was already rejected.`))
        return
      }
      if (!existingApproval) {
        const approved =
          flags.yes ||
          (await confirm({
            message: migrationApprovalPrompt(),
            default: false,
          }))
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
          for (const line of renderMigrationStageStatus({
            runId,
            phase: 'create-teams',
            workflowStatus: 'running',
            updatedAt: planned.migration?.updatedAt,
          })) {
            this.log(line)
          }
          return
        }
      }
    }

    if ((planned.migration?.blockingElicitations.length ?? 0) > 0) {
      for (const line of renderMigrationStageStatus({
        runId,
        phase: planned.migration?.phase ?? 'dry-run',
        workflowStatus: 'blocked',
        updatedAt: planned.migration?.updatedAt,
        blockingCount: planned.migration?.blockingElicitations.length,
      })) {
        this.log(chalk.yellow(line))
      }
      this.log('Run this command with --sessions to switch to and resolve it.')
      return
    }

    if (planned.workflowStatus.toLowerCase() !== 'completed') {
      if (!flags.foreground) {
        for (const line of renderMigrationStageStatus({
          runId,
          phase: planned.migration?.phase ?? 'dry-run',
          workflowStatus: planned.workflowStatus,
          updatedAt: planned.migration?.updatedAt,
          blockingCount: planned.migration?.blockingElicitations.length,
        })) {
          this.log(chalk.cyan(line))
        }
        return
      }
      const completed = await Effect.runPromise(
        waitForMigration(
          runId,
          (status) => status.workflowStatus.toLowerCase() === 'completed',
        ).pipe(Effect.provide(workerLayer)),
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

    for (const line of renderOutcomeConfirmation({
      title: 'Migration complete.',
      reference: runId,
      result: apply
        ? 'Approved GitHub changes were applied and the durable workflow completed.'
        : 'The dry-run completed without target writes.',
      record: reportPath,
      nextStep: apply
        ? 'Review the report and resolve any skipped items or edge cases.'
        : 'Review the exact plan and edge cases before deciding whether to run with --apply.',
    })) {
      this.log(chalk.green(line))
    }
  }
}
