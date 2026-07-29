import {writeFile} from 'node:fs/promises'
import {Effect, Layer, Schema} from 'effect'
import {MarkdownReporter} from '../reporters/markdown.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  EntraServiceTag,
  GitHubServiceTag,
  ReportWriterTag,
} from '../effect/services.js'
import {
  AdoMemberSchema,
  AdoTeamSchema,
  EntraIdentitySchema,
  GitHubTeamSchema,
  GitHubUserSchema,
} from '../effect/schemas.js'
import {retryTransient} from '../effect/retry.js'
import {classifyServiceError} from '../effect/classify.js'
import type {SandboxApprovalDecider, SandboxRuntime} from './runtime.js'
import type {AdoMember, AdoTeam, EntraIdentity, GitHubTeam, GitHubUser} from '../types/index.js'

const fastSandboxRetry = {baseDelayMs: 1}

function retrySandbox<A, E>(
  runtime: SandboxRuntime,
  operation: Parameters<SandboxRuntime['serialize']>[0],
  args: unknown,
  effect: Effect.Effect<A, E>,
) {
  return runtime.serialize(operation, args, retryTransient(effect, fastSandboxRetry))
}

type DecodedAdoTeam = Schema.Schema.Type<typeof AdoTeamSchema>
type DecodedAdoMember = Schema.Schema.Type<typeof AdoMemberSchema>
type DecodedEntraIdentity = Schema.Schema.Type<typeof EntraIdentitySchema>
type DecodedGitHubTeam = Schema.Schema.Type<typeof GitHubTeamSchema>
type DecodedGitHubUser = Schema.Schema.Type<typeof GitHubUserSchema>

function toAdoTeam(team: DecodedAdoTeam): AdoTeam {
  return {
    id: team.id,
    name: team.name,
    projectId: team.projectId,
    projectName: team.projectName,
    ...(team.description === undefined ? {} : {description: team.description}),
  }
}

function toAdoMember(member: DecodedAdoMember): AdoMember {
  return {
    id: member.id,
    displayName: member.displayName,
    uniqueName: member.uniqueName,
    isContainer: member.isContainer,
    ...(member.email === undefined ? {} : {email: member.email}),
    ...(member.descriptor === undefined ? {} : {descriptor: member.descriptor}),
  }
}

function toEntraIdentity(identity: DecodedEntraIdentity): EntraIdentity {
  return {
    id: identity.id,
    displayName: identity.displayName,
    userPrincipalName: identity.userPrincipalName,
    isGuest: identity.isGuest,
    ...(identity.mail === undefined ? {} : {mail: identity.mail}),
    ...(identity.accountEnabled === undefined ? {} : {accountEnabled: identity.accountEnabled}),
  }
}

function toGitHubTeam(team: DecodedGitHubTeam): GitHubTeam {
  return {
    slug: team.slug,
    name: team.name,
    privacy: team.privacy,
    ...(team.id === undefined ? {} : {id: team.id}),
    ...(team.description === undefined ? {} : {description: team.description}),
  }
}

function toGitHubUser(user: DecodedGitHubUser): GitHubUser {
  return {
    login: user.login,
    type: user.type,
    ...(user.email === undefined ? {} : {email: user.email}),
    ...(user.suspended === undefined ? {} : {suspended: user.suspended}),
  }
}

export function makeSandboxBoundaryLayers(runtime: SandboxRuntime) {
  const ado = Layer.succeed(AdoServiceTag, {
    getTeams: (projectName) =>
      retrySandbox(
        runtime,
        'ado.getTeams',
        {projectName},
        runtime
          .invoke('ado.getTeams', {projectName}, Schema.Array(AdoTeamSchema))
          .pipe(Effect.map((teams) => teams.map(toAdoTeam))),
      ),
    getTeamMembers: (projectId, teamId) =>
      retrySandbox(
        runtime,
        'ado.getTeamMembers',
        {projectId, teamId},
        runtime
          .invoke('ado.getTeamMembers', {projectId, teamId}, Schema.Array(AdoMemberSchema))
          .pipe(Effect.map((members) => members.map(toAdoMember))),
      ),
    resolveGroupOriginId: (descriptor) =>
      runtime.invoke('ado.resolveGroupOriginId', {descriptor}, Schema.NullOr(Schema.String)),
  })

  const github = Layer.succeed(GitHubServiceTag, {
    getTeamBySlug: (slug) =>
      runtime
        .invoke('github.getTeamBySlug', {slug}, Schema.NullOr(GitHubTeamSchema))
        .pipe(Effect.map((team) => (team === null ? null : toGitHubTeam(team)))),
    createTeam: (team) =>
      retrySandbox(
        runtime,
        'github.createTeam',
        {team},
        runtime
          .invoke('github.createTeam', {team}, GitHubTeamSchema)
          .pipe(Effect.map(toGitHubTeam)),
      ),
    addTeamMember: (teamSlug, username) =>
      retrySandbox(
        runtime,
        'github.addTeamMember',
        {teamSlug, username},
        runtime
          .invoke('github.addTeamMember', {teamSlug, username}, Schema.Null)
          .pipe(Effect.asVoid),
      ),
    findUserByEmail: (email) =>
      runtime
        .invoke('github.findUserByEmail', {email}, Schema.NullOr(GitHubUserSchema))
        .pipe(Effect.map((user) => (user === null ? null : toGitHubUser(user)))),
    isUserSuspended: (login) => runtime.invoke('github.isUserSuspended', {login}, Schema.Boolean),
    isTeamIdpManaged: (teamSlug) =>
      runtime.invoke('github.isTeamIdpManaged', {teamSlug}, Schema.Boolean),
    getOrganizationBasePermission: () =>
      runtime.invoke(
        'github.getOrganizationBasePermission',
        {},
        Schema.Union(
          Schema.Literal('none'),
          Schema.Literal('read'),
          Schema.Literal('triage'),
          Schema.Literal('write'),
          Schema.Literal('maintain'),
          Schema.Literal('admin'),
        ),
      ),
    getRepository: (repository) =>
      runtime.invoke(
        'github.getRepository',
        {repository},
        Schema.Struct({
          fullName: Schema.String,
          archived: Schema.Boolean,
          visibility: Schema.Union(
            Schema.Literal('public'),
            Schema.Literal('private'),
            Schema.Literal('internal'),
          ),
        }),
      ),
    listTeamRepositories: (teamSlug) =>
      runtime
        .invoke('github.listTeamRepositories', {teamSlug}, Schema.Array(Schema.String))
        .pipe(Effect.map((repositories) => [...repositories])),
    getTeamRepositoryPermission: (teamSlug, repository) =>
      runtime.invoke(
        'github.getTeamRepositoryPermission',
        {teamSlug, repository},
        Schema.NullOr(
          Schema.Union(
            Schema.Literal('read'),
            Schema.Literal('triage'),
            Schema.Literal('write'),
            Schema.Literal('maintain'),
            Schema.Literal('admin'),
          ),
        ),
      ),
    setTeamRepositoryPermission: (teamSlug, repository, role) =>
      retrySandbox(
        runtime,
        'github.setTeamRepositoryPermission',
        {teamSlug, repository, role},
        runtime
          .invoke('github.setTeamRepositoryPermission', {teamSlug, repository, role}, Schema.Null)
          .pipe(Effect.asVoid),
      ),
  })

  const entra = Layer.succeed(EntraServiceTag, {
    getGroupMembers: (groupId, transitive) =>
      retrySandbox(
        runtime,
        'entra.getGroupMembers',
        {
          groupId,
          ...(transitive === undefined ? {} : {transitive}),
        },
        runtime
          .invoke(
            'entra.getGroupMembers',
            {
              groupId,
              ...(transitive === undefined ? {} : {transitive}),
            },
            Schema.Array(EntraIdentitySchema),
          )
          .pipe(Effect.map((identities) => identities.map(toEntraIdentity))),
      ),
    resolveUserByUpn: (upn) =>
      runtime
        .invoke('entra.resolveUserByUpn', {upn}, Schema.NullOr(EntraIdentitySchema))
        .pipe(Effect.map((identity) => (identity === null ? null : toEntraIdentity(identity)))),
  })

  return Layer.mergeAll(ado, github, entra)
}

export function makeSandboxApprovalLayer(runtime: SandboxRuntime, decide?: SandboxApprovalDecider) {
  return Layer.succeed(ApprovalServiceTag, {
    request: (request) => runtime.requestApproval(request, decide),
    history: Effect.sync(() => Array.from(runtime.approvalHistory())),
  })
}

export function makeSandboxReportWriterLayer(runtime: SandboxRuntime, configDigest: string) {
  return Layer.succeed(ReportWriterTag, {
    write: (report, outputPath, durationMs) =>
      Effect.tryPromise({
        try: async () => {
          const markdown = new MarkdownReporter().render(
            {
              ...report,
              sandbox: {
                scenario: runtime.scenario.id,
                title: runtime.scenario.title,
                configDigest,
                transcript: Array.from(runtime.transcript()),
              },
            },
            durationMs,
          )
          await writeFile(outputPath, markdown, 'utf8')
        },
        catch: (error) => classifyServiceError('report', error),
      }),
  })
}
