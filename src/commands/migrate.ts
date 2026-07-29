import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
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
import {FailureMode} from '../types/failures.js'
import {ConflictResolver} from '../healing/conflict-resolver.js'
import {HealingDispatcher} from '../healing/dispatcher.js'
import {
  AuthLiveLayer,
  makeAdoLayer,
  makeApprovalLayer,
  makeCheckpointLayer,
  makeEntraLayer,
  makeGitHubLayer,
  ReportWriterLiveLayer,
  validateCredentialsEffect,
} from '../effect/layers.js'
import {runEffectMigration} from '../effect/migration.js'
import {AuthServiceTag} from '../effect/services.js'

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
    const skippedItems: SkippedItem[] = []

    const state = await this.getOrCreateState(options)
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
        existing.apply !== options.apply
      ) {
        throw new Error(`Checkpoint ${options.resume} is incompatible with the requested migration scope.`)
      }
      return existing
    }

    const state: CheckpointState = {
      schemaVersion: 1,
      runId: randomUUID(),
      timestamp: this.now().toISOString(),
      adoOrg: options.adoOrg,
      adoProject: options.adoProject,
      githubOrg: options.githubOrg,
      apply: options.apply,
      phase: 'fetch',
      completedTeams: [],
      completedMemberPairs: [],
      pendingTeams: [],
      mappings: [],
      edgeCases: [],
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
      required: true,
    }),
    'ado-project': Flags.string({
      description: 'Azure DevOps project name',
      required: true,
    }),
    'github-org': Flags.string({
      description: 'GitHub organization name',
      required: true,
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
    concurrency: Flags.integer({
      description: 'Maximum concurrent mapping requests',
      default: 4,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Migrate)
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthServiceTag
        return yield* auth.resolveCredentials
      }).pipe(Effect.provide(AuthLiveLayer)),
    )

    await Effect.runPromise(validateCredentialsEffect(credentials, flags['ado-org']))

    const runtimeLayer = Layer.mergeAll(
      makeAdoLayer(credentials, flags['ado-org']),
      makeGitHubLayer(credentials, flags['github-org']),
      makeEntraLayer(credentials),
      makeApprovalLayer(flags.yes),
      makeCheckpointLayer(),
      ReportWriterLiveLayer,
    )

    const result = await Effect.runPromise(
      runEffectMigration({
        adoOrg: flags['ado-org'],
        adoProject: flags['ado-project'],
        githubOrg: flags['github-org'],
        apply: flags.apply,
        concurrency: Math.max(1, flags.concurrency),
        ...(flags.output ? {output: flags.output} : {}),
        ...(flags.prefix ? {prefix: flags.prefix} : {}),
        ...(flags.suffix ? {suffix: flags.suffix} : {}),
        ...(flags.resume ? {resume: flags.resume} : {}),
      }).pipe(Effect.provide(runtimeLayer)),
    )

    this.log(chalk.green(`Migration complete. Run ID: ${result.runId}`))
    this.log(chalk.green(`Report written to ${result.reportPath}`))
  }
}
