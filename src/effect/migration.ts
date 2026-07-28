import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Effect, Ref} from 'effect'
import {ConflictResolver} from '../healing/conflict-resolver.js'
import type {
  AdoMember,
  AdoTeam,
  CheckpointState,
  EdgeCase,
  EdgeCaseReason,
  FailureLogEntry,
  MappingResult,
  MigrationReport,
  UserMappingResult,
} from '../types/index.js'
import {CHECKPOINT_SCHEMA_VERSION} from '../types/index.js'
import {
  NotFoundFailure,
  PermissionFailure,
  type DomainFailure,
  toFailureMode,
  ValidationFailure,
} from './errors.js'
import {
  AdoServiceTag,
  ApprovalServiceTag,
  CheckpointStoreTag,
  EntraServiceTag,
  GitHubServiceTag,
  ReportWriterTag,
  type AdoServiceFx,
  type ApprovalService,
  type EntraServiceFx,
  type GitHubServiceFx,
} from './services.js'

const recommendationByEdge: Record<EdgeCaseReason, string> = {
  'no-ghemu-account': 'Invite user to GitHub org as GHEMU user',
  'guest-user': 'Guest accounts cannot be GHEMU users; create a GitHub.com account manually',
  'disabled-account': 'Enable the user in Entra and provision the account before migrating',
  'unresolved-identity': 'Resolve the Azure DevOps identity to an active Entra user before migrating',
  'suspended-account': 'Reactivate user in GitHub before migrating',
  'ambiguous-match': 'Multiple GitHub users match this email; specify login manually',
  'missing-email': 'User has no verified email in Entra; add email to Entra profile',
  'circular-group-member': 'Remove circular group reference in Entra before migrating',
  'entra-role-only': 'Service account or role; create corresponding GitHub bot/team manually',
  'ado-project-role': 'ADO project roles (Project Admin, Build Admin) have no GitHub equivalent; assign GitHub team maintainer role manually',
  'nested-group-skipped': 'Nested group exceeded depth limit; enumerate group members manually',
}

export interface EffectMigrationOptions {
  readonly adoOrg: string
  readonly adoProject: string
  readonly githubOrg: string
  readonly apply: boolean
  readonly output?: string
  readonly prefix?: string
  readonly suffix?: string
  readonly resume?: string
  readonly concurrency: number
}

function edge(
  reason: EdgeCaseReason,
  details: string,
  adoIdentity?: AdoMember,
  adoTeam?: AdoTeam,
): EdgeCase {
  const value: EdgeCase = {
    reason,
    details,
    recommendation: recommendationByEdge[reason],
  }
  if (adoIdentity) {
    value.adoIdentity = adoIdentity
  }
  if (adoTeam) {
    value.adoTeam = adoTeam
  }
  return value
}

function roleLike(displayName: string): boolean {
  return /(project|build|release).*(admin|administrator|role)/i.test(displayName)
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function reportFromState(
  state: CheckpointState,
  dryRun: boolean,
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
    skippedItems: state.skippedItems,
    failureLog: state.failureLog,
    approvalHistory: state.approvalHistory,
  }
}

function initialState(options: EffectMigrationOptions): CheckpointState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    adoOrg: options.adoOrg,
    adoProject: options.adoProject,
    githubOrg: options.githubOrg,
    migrationConfig: {
      apply: options.apply,
      prefix: options.prefix ?? '',
      suffix: options.suffix ?? '',
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
}

function checkpointMismatch(
  state: CheckpointState,
  options: EffectMigrationOptions,
): string | null {
    const expected = {
      adoOrg: options.adoOrg,
      adoProject: options.adoProject,
      githubOrg: options.githubOrg,
      apply: options.apply,
      prefix: options.prefix ?? '',
      suffix: options.suffix ?? '',
    }
    const actual = {
      adoOrg: state.adoOrg,
      adoProject: state.adoProject,
      githubOrg: state.githubOrg,
      apply: state.migrationConfig.apply,
      prefix: state.migrationConfig.prefix,
      suffix: state.migrationConfig.suffix,
    }
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (expected[key] !== actual[key]) {
        return `${key} expected ${JSON.stringify(actual[key])} but received ${JSON.stringify(expected[key])}`
      }
    }
    return null
}

function duplicateSourceSlug(mappings: MappingResult[]): {slug: string; teams: string[]} | null {
    const teamsBySlug = new Map<string, string[]>()
    for (const mapping of mappings) {
      const teams = teamsBySlug.get(mapping.githubTeam.slug) ?? []
      teams.push(mapping.adoTeam.name)
      teamsBySlug.set(mapping.githubTeam.slug, teams)
    }
    for (const [slug, teams] of teamsBySlug) {
      if (teams.length > 1) {
        return {slug, teams}
      }
    }
    return null
}

function deduplicateMappedMembers(memberMappings: UserMappingResult[]): UserMappingResult[] {
    const mappedLogins = new Set<string>()
    return memberMappings.filter((mapping) => {
      const login = mapping.githubUser?.login
      if (!mapping.mapped || !login) {
        return true
      }
      if (mappedLogins.has(login)) {
        return false
      }
      mappedLogins.add(login)
      return true
    })
}

function mapMember(
  member: AdoMember,
  team: AdoTeam,
  github: GitHubServiceFx,
  entra: EntraServiceFx,
): Effect.Effect<UserMappingResult, DomainFailure> {
  return Effect.gen(function* () {
    if (roleLike(member.displayName)) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge('ado-project-role', `Role assignment detected: ${member.displayName}`, member, team),
      }
    }
    if (!member.uniqueName.includes('@') && !member.email) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge('entra-role-only', `Role-only identity: ${member.displayName}`, member, team),
      }
    }

    const identityByUniqueName = yield* entra.resolveUserByUpn(member.uniqueName)
    const identity =
      identityByUniqueName ??
      (member.email ? yield* entra.resolveUserByUpn(member.email) : null)

    if (!identity) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'unresolved-identity',
          `No Entra identity found for ${member.displayName}`,
          member,
          team,
        ),
      }
    }
    if (identity.isGuest) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge('guest-user', `Guest account: ${identity.userPrincipalName}`, member, team),
      }
    }
    if (identity.accountEnabled === false) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'disabled-account',
          `Entra account is disabled: ${identity.userPrincipalName}`,
          member,
          team,
        ),
      }
    }

    const candidateEmail = identity.mail ?? identity.userPrincipalName
    if (!candidateEmail || !isValidEmail(candidateEmail)) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge('missing-email', `No valid email for ${member.displayName}`, member, team),
      }
    }

    const matchedUserOrError = yield* Effect.either(github.findUserByEmail(candidateEmail))
    if (matchedUserOrError._tag === 'Left') {
      if (
        matchedUserOrError.left instanceof ValidationFailure &&
        matchedUserOrError.left.message.includes('Multiple GitHub users match email')
      ) {
        return {
          adoIdentity: member,
          mapped: false,
          edgeCase: edge(
            'ambiguous-match',
            `Unable to resolve single GitHub account for ${candidateEmail}: ${matchedUserOrError.left.message}`,
            member,
            team,
          ),
        }
      }

      return yield* Effect.fail(matchedUserOrError.left)
    }
    const matchedUser = matchedUserOrError.right
    if (!matchedUser) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge('no-ghemu-account', `No GitHub account found for ${candidateEmail}`, member, team),
      }
    }

    const suspended = yield* github.isUserSuspended(matchedUser.login)
    if (suspended) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge('suspended-account', `GitHub user ${matchedUser.login} is suspended`, member, team),
      }
    }

    return {
      adoIdentity: member,
      githubUser: matchedUser,
      mapped: true,
    }
  })
}

function mapTeam(
  team: AdoTeam,
  members: AdoMember[],
  options: EffectMigrationOptions,
  ado: AdoServiceFx,
  github: GitHubServiceFx,
  entra: EntraServiceFx,
  approval: ApprovalService,
): Effect.Effect<MappingResult, DomainFailure> {
  return Effect.gen(function* () {
    const resolver = new ConflictResolver()
    const teamName = `${options.prefix ?? ''}${team.name}${options.suffix ?? ''}`.trim()
    let slug = resolver.slugify(teamName)
    const existing = yield* github.getTeamBySlug(slug)
    if (existing && existing.name !== teamName) {
      const approved = yield* approval.request({
        action: 'Resolve team name conflict',
        context: {adoName: teamName, existingSlug: existing.slug},
        displayLines: [
          `Conflict for team ${teamName}`,
          `Existing slug: ${existing.slug}`,
          `Suggested slug: ${resolver.suggestAlternative(slug, existing.slug)}`,
        ],
        autoApprovable: false,
      })
      if (approved) {
        slug = resolver.suggestAlternative(slug, existing.slug)
      } else {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'github',
            message: `Team name conflict resolution rejected for ${teamName}`,
          }),
        )
      }
    }

    const memberMappings: UserMappingResult[] = []
    const edgeCases: EdgeCase[] = []

    for (const member of members) {
      if (!member.isContainer) {
        const mapping = yield* mapMember(member, team, github, entra)
        memberMappings.push(mapping)
        if (mapping.edgeCase) {
          edgeCases.push(mapping.edgeCase)
        }
        continue
      }

      const groupDescriptor = member.descriptor ?? member.id
      const groupOriginId = yield* ado.resolveGroupOriginId(groupDescriptor)
      if (!groupOriginId) {
        return yield* Effect.fail(
          new NotFoundFailure({
            service: 'ado',
            message: `Unable to resolve Entra group id for ADO container ${member.displayName}`,
          }),
        )
      }

      const expanded = yield* Effect.either(entra.getGroupMembers(groupOriginId, true))
      if (expanded._tag === 'Left') {
        const details = expanded.left.message
        if (
          expanded.left instanceof ValidationFailure &&
          (details.toLowerCase().includes('circular') ||
            details.toLowerCase().includes('nested group depth limit exceeded'))
        ) {
          const reason = details.toLowerCase().includes('circular')
            ? 'circular-group-member'
            : 'nested-group-skipped'
          edgeCases.push(edge(reason, details, member, team))
          continue
        }

        return yield* Effect.fail(expanded.left)
      }
      for (const identity of expanded.right) {
        const mapped = yield* mapMember(
          {
            id: identity.id,
            displayName: identity.displayName,
            uniqueName: identity.userPrincipalName,
            isContainer: false,
            ...(identity.mail ? {email: identity.mail} : {}),
          },
          team,
          github,
          entra,
        )
        memberMappings.push(mapped)
        if (mapped.edgeCase) {
          edgeCases.push(mapped.edgeCase)
        }
      }
    }

    return {
      adoTeam: team,
      githubTeam: {
        slug,
        name: teamName,
        privacy: 'closed',
        ...(team.description ? {description: team.description} : {}),
      },
      memberMappings: deduplicateMappedMembers(memberMappings),
      edgeCases,
    }
  })
}

function updateWithFailure(
  state: CheckpointState,
  failure: DomainFailure,
  action: string,
): CheckpointState {
  const entry: FailureLogEntry = {
    failureMode: toFailureMode(failure),
    error: failure.message,
    healingAction: action,
    resolved: false,
  }
  return {
    ...state,
    failureLog: [...state.failureLog, entry],
  }
}

export function runEffectMigration(
  options: EffectMigrationOptions,
) {
  return Effect.gen(function* () {
    const ado = yield* AdoServiceTag
    const github = yield* GitHubServiceTag
    const entra = yield* EntraServiceTag
    const checkpoints = yield* CheckpointStoreTag
    const approval = yield* ApprovalServiceTag
    const reportWriter = yield* ReportWriterTag

    const startedAt = Date.now()
    const shouldPersistRef = yield* Ref.make(true)
    const loadedState = options.resume ? yield* checkpoints.load(options.resume) : null
    if (options.resume && !loadedState) {
      return yield* Effect.fail(
        new NotFoundFailure({
          service: 'checkpoint',
          message: `Checkpoint ${options.resume} was not found.`,
        }),
      )
    }
    if (loadedState) {
      const mismatch = checkpointMismatch(loadedState, options)
      if (mismatch) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'checkpoint',
            message: `Checkpoint ${loadedState.runId} is incompatible: ${mismatch}`,
          }),
        )
      }
    }
    const stateRef = yield* Ref.make(loadedState ?? initialState(options))
    if (!loadedState) {
      yield* checkpoints.save(yield* Ref.get(stateRef))
    }

    const saveState = (next: CheckpointState) =>
      Ref.set(stateRef, next).pipe(Effect.zipRight(checkpoints.save(next)))

    const currentAtStart = yield* Ref.get(stateRef)
    const reportPath =
      options.output ?? path.resolve(process.cwd(), `migration-report-${currentAtStart.runId}.md`)

    const program = Effect.gen(function* () {
      let state = yield* Ref.get(stateRef)

      if (state.phase === 'fetch') {
        const teams = yield* ado.getTeams(options.adoProject)
        state = {
          ...state,
          phase: 'map',
          pendingTeams: teams,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      if (state.phase === 'map') {
        const mapped = yield* Effect.forEach(
          state.pendingTeams,
          (team) =>
            Effect.gen(function* () {
              const members = yield* ado.getTeamMembers(team.projectId, team.id)
              return yield* mapTeam(team, members, options, ado, github, entra, approval)
            }),
          {concurrency: Math.max(1, options.concurrency)},
        )
        const collision = duplicateSourceSlug(mapped)
        if (collision) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'github',
              message: `Azure DevOps teams ${collision.teams.join(', ')} normalize to the same GitHub slug ${collision.slug}`,
            }),
          )
        }
        state = {
          ...state,
          phase: 'dry-run',
          mappings: mapped,
          edgeCases: mapped.flatMap((m) => m.edgeCases),
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      if (state.phase === 'dry-run') {
        const report = reportFromState(state, !options.apply)
        yield* reportWriter.write(report, reportPath, Date.now() - startedAt)
        if (!options.apply) {
          yield* checkpoints.delete(state.runId)
          yield* Ref.set(shouldPersistRef, false)
          return {reportPath, runId: state.runId}
        }
        state = {
          ...state,
          phase: 'create-teams',
          approvalHistory: yield* approval.history,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      if (state.phase === 'create-teams') {
        const approved = yield* approval.request({
          action: `Create ${state.mappings.length} teams in ${state.githubOrg}`,
          context: {teamCount: state.mappings.length, githubOrg: state.githubOrg},
          displayLines: state.mappings.map((m) => `- ${m.githubTeam.slug}`),
          autoApprovable: false,
        })
        state = {
          ...(yield* Ref.get(stateRef)),
          approvalHistory: yield* approval.history,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
        if (!approved) {
          return yield* Effect.fail(
            new PermissionFailure({
              service: 'approval',
              message: 'Destructive team creation not approved',
              ssoRequired: false,
            }),
          )
        }

        for (const mapping of state.mappings) {
          state = yield* Ref.get(stateRef)
          if (state.completedTeams.includes(mapping.githubTeam.slug)) {
            continue
          }
          const created = yield* Effect.either(
            github.createTeam({
              slug: mapping.githubTeam.slug,
              name: mapping.githubTeam.name,
              privacy: mapping.githubTeam.privacy,
              ...(mapping.githubTeam.description ? {description: mapping.githubTeam.description} : {}),
            }),
          )
          if (created._tag === 'Left') {
            state = updateWithFailure(state, created.left, 'Recorded team create failure')
            yield* saveState(state)
            if (created.left instanceof PermissionFailure && created.left.ssoRequired) {
              const skip = yield* approval.request({
                action: 'Skip SSO-enforced team write',
                context: {team: mapping.githubTeam.slug},
                displayLines: [created.left.message],
                autoApprovable: false,
              })
              if (!skip) {
                return yield* Effect.fail(created.left)
              }
              state = {
                ...(yield* Ref.get(stateRef)),
                approvalHistory: yield* approval.history,
                skippedItems: [
                  ...(yield* Ref.get(stateRef)).skippedItems,
                  {type: 'team', name: mapping.githubTeam.name, reason: created.left.message},
                ],
              }
              yield* saveState(state)
              continue
            }

            return yield* Effect.fail(created.left)
          }

          state = {
            ...state,
            completedTeams: [...state.completedTeams, mapping.githubTeam.slug],
            approvalHistory: yield* approval.history,
          }
          yield* saveState(state)
        }

        state = {
          ...(yield* Ref.get(stateRef)),
          phase: 'assign-members',
          approvalHistory: yield* approval.history,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
      }

      state = yield* Ref.get(stateRef)
      if (state.phase === 'assign-members') {
        const plannedMembers = state.mappings.flatMap((mapping) =>
          state.completedTeams.includes(mapping.githubTeam.slug)
            ? mapping.memberMappings
                .filter((member) => member.mapped && member.githubUser)
                .map((member) => `${mapping.githubTeam.slug}:${member.githubUser?.login ?? ''}`)
            : [],
        )
        const approved = yield* approval.request({
          action: `Add ${plannedMembers.length} members across ${state.mappings.length} teams`,
          context: {memberCount: plannedMembers.length, teamCount: state.mappings.length},
          displayLines: [`Assignments: ${plannedMembers.length}`],
          autoApprovable: false,
        })
        state = {
          ...(yield* Ref.get(stateRef)),
          approvalHistory: yield* approval.history,
          timestamp: new Date().toISOString(),
        }
        yield* saveState(state)
        if (!approved) {
          return yield* Effect.fail(
            new PermissionFailure({
              service: 'approval',
              message: 'Destructive member assignment not approved',
              ssoRequired: false,
            }),
          )
        }

        for (const mapping of state.mappings) {
          state = yield* Ref.get(stateRef)
          if (!state.completedTeams.includes(mapping.githubTeam.slug)) {
            continue
          }
          for (const member of mapping.memberMappings) {
            const login = member.githubUser?.login
            if (!member.mapped || !login) {
              continue
            }
            state = yield* Ref.get(stateRef)
            const pair = `${mapping.githubTeam.slug}:${login}`
            if (state.completedMemberPairs.includes(pair)) {
              continue
            }
            const assigned = yield* Effect.either(github.addTeamMember(mapping.githubTeam.slug, login))
            if (assigned._tag === 'Left') {
              state = updateWithFailure(state, assigned.left, 'Recorded member add failure')
              yield* saveState(state)
              if (assigned.left instanceof PermissionFailure && assigned.left.ssoRequired) {
                const skip = yield* approval.request({
                  action: 'Skip SSO-enforced member write',
                  context: {team: mapping.githubTeam.slug, login},
                  displayLines: [assigned.left.message],
                  autoApprovable: false,
                })
                if (!skip) {
                  return yield* Effect.fail(assigned.left)
                }
                state = {
                  ...(yield* Ref.get(stateRef)),
                  approvalHistory: yield* approval.history,
                  skippedItems: [
                    ...(yield* Ref.get(stateRef)).skippedItems,
                    {type: 'member', name: pair, reason: assigned.left.message},
                  ],
                }
                yield* saveState(state)
                continue
              }

              if (
                (assigned.left instanceof ValidationFailure && assigned.left.status === 422) ||
                assigned.left instanceof NotFoundFailure
              ) {
                state = {
                  ...(yield* Ref.get(stateRef)),
                  skippedItems: [
                    ...(yield* Ref.get(stateRef)).skippedItems,
                    {type: 'member', name: pair, reason: assigned.left.message},
                  ],
                }
                yield* saveState(state)
                continue
              }

              return yield* Effect.fail(assigned.left)
            }
            state = {
              ...state,
              completedMemberPairs: [...state.completedMemberPairs, pair],
              approvalHistory: yield* approval.history,
            }
            yield* saveState(state)
          }
        }

        state = {
          ...(yield* Ref.get(stateRef)),
          phase: 'report',
          timestamp: new Date().toISOString(),
          approvalHistory: yield* approval.history,
        }
        yield* saveState(state)
      }

      state = yield* Ref.get(stateRef)
      const report = reportFromState(state, false)
      yield* reportWriter.write(report, reportPath, Date.now() - startedAt)
      yield* checkpoints.delete(state.runId)
      yield* Ref.set(shouldPersistRef, false)
      return {reportPath, runId: state.runId}
    })

    return yield* program.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const shouldPersist = yield* Ref.get(shouldPersistRef)
          if (!shouldPersist) {
            return
          }
          const latest = yield* Ref.get(stateRef)
          yield* checkpoints.save(latest).pipe(Effect.catchAll(() => Effect.void))
        }),
      ),
    )
  })
}
