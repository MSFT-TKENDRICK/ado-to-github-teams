import {readFile, writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import {confirm} from '@inquirer/prompts'
import type {Client} from '@microsoft/microsoft-graph-client'
import {Effect, Layer, Ref} from 'effect'
import {AuthManager, type ResolvedCredentials} from '../auth/manager.js'
import {
  validateAdoCredential,
  validateEntraCredential,
  validateGitHubCredential,
} from '../auth/validate.js'
import {MarkdownReporter} from '../reporters/markdown.js'
import {CheckpointManager} from '../checkpoints/manager.js'
import {AdoService} from '../services/ado.js'
import {EntraService} from '../services/entra.js'
import {GitHubService} from '../services/github.js'
import type {
  ApprovalRecord,
  ApprovalRequest,
  CheckpointState,
  MigrationReport,
} from '../types/index.js'
import {classifyServiceError} from './classify.js'
import {
  BlockingElicitationFailure,
  DecodeFailure,
  type DomainFailure,
} from './errors.js'
import {makeInFlightDeduplicator} from './in-flight.js'
import {decodeConfig} from './schemas.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  AuthServiceTag,
  CheckpointStoreTag,
  EntraServiceTag,
  GitHubServiceTag,
  ReportWriterTag,
  type CheckpointStore,
} from './services.js'
import {retryTransient} from './retry.js'

const defaultCheckpointDatabase = path.join(homedir(), '.ado-github-teams', 'workflow.db')

export const AuthLiveLayer = Layer.effect(
  AuthServiceTag,
  Effect.succeed({
    resolveCredentials: Effect.gen(function* () {
      const manager = new AuthManager()
      const rawConfig = yield* Effect.tryPromise({
        try: async () => {
          try {
            const raw = await readFile(AuthManager.DEFAULT_CONFIG_PATH, 'utf8')
            return JSON.parse(raw) as unknown
          } catch (error) {
            const nodeError = error as NodeJS.ErrnoException
            if (nodeError.code === 'ENOENT') {
              return {}
            }
            throw error
          }
        },
        catch: (error) =>
          new DecodeFailure({
            service: 'auth',
            message: `Failed to parse config: ${String(error)}`,
            raw: error,
          }),
      })
      yield* decodeConfig(rawConfig)
      return yield* Effect.tryPromise({
        try: async () => manager.resolveCredentials(),
        catch: (error) => classifyServiceError('auth', error),
      })
    }),
  }),
)

export function makeApprovalLayer(yesFlag: boolean) {
  return Layer.effect(
    ApprovalServiceTag,
    Effect.gen(function* () {
      const historyRef = yield* Ref.make<ApprovalRecord[]>([])
      const request = (request: ApprovalRequest): Effect.Effect<boolean, DomainFailure> =>
        Effect.gen(function* () {
          for (const line of request.displayLines) {
            yield* Effect.logInfo(chalk.cyan(line))
          }

          const approved =
            yesFlag && request.autoApprovable
              ? true
              : yield* Effect.tryPromise({
                  try: async () =>
                    confirm({
                      message: `${request.action} (${JSON.stringify(request.context)})`,
                      default: false,
                    }),
                  catch: (error) => classifyServiceError('approval', error),
                })
          const record: ApprovalRecord = {
            action: request.action,
            context: JSON.stringify(request.context),
            approved,
            timestamp: new Date().toISOString(),
          }
          yield* Ref.update(historyRef, (current) => [...current, record])
          return approved
        })
      return {
        request,
        history: Ref.get(historyRef),
      }
    }),
  )
}

export function makeWorkflowApprovalLayer(
  allowDestructive: boolean,
  initialHistory: ApprovalRecord[] = [],
) {
  return Layer.effect(
    ApprovalServiceTag,
    Effect.gen(function* () {
      const historyRef = yield* Ref.make<ApprovalRecord[]>([...initialHistory])
      const hasApplyApproval = initialHistory.some(
        (record) => record.action === 'Apply migration' && record.approved,
      )
      const request = (request: ApprovalRequest): Effect.Effect<boolean, DomainFailure> =>
        Effect.gen(function* () {
          const isPlanningDecision = request.action === 'Resolve team name conflict'
          const isApprovedPlanWrite =
            /^Create \d+ teams in .+$/.test(request.action) ||
            /^Add \d+ members across \d+ teams$/.test(request.action)
          const approved =
            isPlanningDecision ||
            (allowDestructive && hasApplyApproval && isApprovedPlanWrite)
          if (!approved && request.elicitation) {
            return yield* Effect.fail(
              new BlockingElicitationFailure({request}),
            )
          }
          const record: ApprovalRecord = {
            action: request.action,
            context: JSON.stringify(request.context),
            approved,
            timestamp: new Date().toISOString(),
          }
          yield* Ref.update(historyRef, (current) => [...current, record])
          return approved
        })
      return {
        request,
        history: Ref.get(historyRef),
      }
    }),
  )
}

export function makeCheckpointLayer(location: string = defaultCheckpointDatabase) {
  const manager = new CheckpointManager(location)
  const store: CheckpointStore = {
    save: (state: CheckpointState) =>
      Effect.tryPromise({
        try: async () => manager.save(state),
        catch: (error) => classifyServiceError('checkpoint', error),
      }),
    load: (runId: string) =>
      Effect.tryPromise({
        try: async () => manager.load(runId),
        catch: (error) => classifyServiceError('checkpoint', error),
      }),
    latest: Effect.gen(function* () {
      return yield* Effect.tryPromise({
        try: async () => manager.loadLatest(),
        catch: (error) => classifyServiceError('checkpoint', error),
      })
    }),
    list: Effect.tryPromise({
      try: async () => manager.listCheckpoints(),
      catch: (error) => classifyServiceError('checkpoint', error),
    }),
    delete: (runId: string) =>
      Effect.tryPromise({
        try: async () => manager.delete(runId),
        catch: (error) => classifyServiceError('checkpoint', error),
      }),
  }
  return Layer.succeed(CheckpointStoreTag, store)
}

export const ReportWriterLiveLayer = Layer.succeed(ReportWriterTag, {
  write: (report: MigrationReport, outputPath: string, durationMs: number) =>
    Effect.gen(function* () {
      const markdown = new MarkdownReporter().render(report, durationMs)
      yield* Effect.tryPromise({
        try: async () => writeFile(outputPath, markdown, 'utf8'),
        catch: (error) => classifyServiceError('report', error),
      })
    }),
})

export function makeAdoLayer(
  credentials: ResolvedCredentials,
  adoOrg: string,
) {
  const service = new AdoService(credentials.ado, adoOrg)
  const inFlight = makeInFlightDeduplicator()
  return Layer.succeed(AdoServiceTag, {
    getTeams: (projectName) =>
      retryTransient(
        Effect.tryPromise({
          try: () => inFlight.run(`teams:${projectName}`, () => service.getTeams(projectName)),
          catch: (error) => classifyServiceError('ado', error),
        }),
      ),
    getTeamMembers: (projectId, teamId) =>
      retryTransient(
        Effect.tryPromise({
          try: () =>
            inFlight.run(`members:${projectId}:${teamId}`, () =>
              service.getTeamMembers(projectId, teamId),
            ),
          catch: (error) => classifyServiceError('ado', error),
        }),
      ),
    resolveGroupOriginId: (descriptor) =>
      Effect.tryPromise({
        try: () =>
          inFlight.run(`group-origin:${descriptor}`, () =>
            service.resolveGroupOriginId(descriptor),
          ),
        catch: (error) => classifyServiceError('ado', error),
      }),
  })
}

export function makeGitHubLayer(
  credentials: ResolvedCredentials,
  githubOrg: string,
  apiBaseUrl?: string,
) {
  const service = new GitHubService(credentials.githubToken, githubOrg, apiBaseUrl)
  const inFlight = makeInFlightDeduplicator()
  return Layer.succeed(GitHubServiceTag, {
    getTeamBySlug: (slug) =>
      Effect.tryPromise({
        try: () => inFlight.run(`team:${slug}`, () => service.getTeamBySlug(slug)),
        catch: (error) => classifyServiceError('github', error),
      }),
    createTeam: (team) =>
      Effect.tryPromise({
        try: async () => service.createTeam(team),
        catch: (error) => classifyServiceError('github', error),
      }),
    addTeamMember: (teamSlug, username) =>
      Effect.tryPromise({
        try: async () => service.addTeamMember(teamSlug, username),
        catch: (error) => classifyServiceError('github', error),
      }),
    findUserByEmail: (email) =>
      Effect.tryPromise({
        try: () =>
          inFlight.run(`user-email:${email.toLowerCase()}`, () => service.findUserByEmail(email)),
        catch: (error) => classifyServiceError('github', error),
      }),
    isUserSuspended: (login) =>
      Effect.tryPromise({
        try: () =>
          inFlight.run(`user-suspended:${login.toLowerCase()}`, () =>
            service.isUserSuspended(login),
          ),
        catch: (error) => classifyServiceError('github', error),
      }),
  })
}

export function makeEntraLayer(
  credentials: ResolvedCredentials,
  graphClient?: Client,
  graphBaseUrl?: string,
) {
  const service = new EntraService(
    credentials.entraCredential,
    credentials.entraScopes,
    graphClient,
    graphBaseUrl,
  )
  const inFlight = makeInFlightDeduplicator()
  return Layer.succeed(EntraServiceTag, {
    getGroupMembers: (groupId, transitive) =>
      retryTransient(
        Effect.tryPromise({
          try: () =>
            inFlight.run(`group-members:${groupId}:${transitive === true}`, () =>
              service.getGroupMembers(groupId, transitive),
            ),
          catch: (error) => classifyServiceError('entra', error),
        }),
      ),
    resolveUserByUpn: (upn) =>
      Effect.tryPromise({
        try: () =>
          inFlight.run(`user-upn:${upn.toLowerCase()}`, () => service.resolveUserByUpn(upn)),
        catch: (error) => classifyServiceError('entra', error),
      }),
  })
}

export function validateCredentialsEffect(
  credentials: ResolvedCredentials,
  adoOrg: string,
): Effect.Effect<void, DomainFailure> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => validateAdoCredential(credentials.ado, adoOrg),
      catch: (error) => classifyServiceError('auth', error),
    })
    yield* Effect.tryPromise({
      try: async () => validateGitHubCredential(credentials.githubToken),
      catch: (error) => classifyServiceError('auth', error),
    })
    yield* Effect.tryPromise({
      try: async () =>
        validateEntraCredential(credentials.entraCredential, credentials.entraScopes),
      catch: (error) => classifyServiceError('auth', error),
    })
  })
}
