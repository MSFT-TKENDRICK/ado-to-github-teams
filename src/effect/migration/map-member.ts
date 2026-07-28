import {Effect} from 'effect'
import type {AdoMember, AdoTeam, UserMappingResult} from '../../types/index.js'
import {ValidationFailure} from '../errors.js'
import {EntraServiceTag, GitHubServiceTag} from '../services.js'
import {createEdgeCase, isProjectRole, isValidEmail} from './edge-cases.js'

export function mapMember(
  member: AdoMember,
  team: AdoTeam,
): Effect.Effect<
  UserMappingResult,
  import('../errors.js').DomainFailure,
  EntraServiceTag | GitHubServiceTag
> {
  return Effect.gen(function* () {
    const github = yield* GitHubServiceTag
    const entra = yield* EntraServiceTag

    if (isProjectRole(member.displayName)) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: createEdgeCase(
          'ado-project-role',
          `Role assignment detected: ${member.displayName}`,
          member,
          team,
        ),
      }
    }
    if (!member.uniqueName.includes('@') && !member.email) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: createEdgeCase(
          'entra-role-only',
          `Role-only identity: ${member.displayName}`,
          member,
          team,
        ),
      }
    }

    const identityByUniqueName = yield* entra.resolveUserByUpn(member.uniqueName)
    const identity =
      identityByUniqueName ??
      (member.email ? yield* entra.resolveUserByUpn(member.email) : null)

    if (identity?.isGuest) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: createEdgeCase(
          'guest-user',
          `Guest account: ${identity.userPrincipalName}`,
          member,
          team,
        ),
      }
    }

    const candidateEmail =
      identity?.mail ?? identity?.userPrincipalName ?? member.email ?? member.uniqueName
    if (!candidateEmail || !isValidEmail(candidateEmail)) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: createEdgeCase(
          'missing-email',
          `No valid email for ${member.displayName}`,
          member,
          team,
        ),
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
          edgeCase: createEdgeCase(
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
        edgeCase: createEdgeCase(
          'no-ghemu-account',
          `No GitHub account found for ${candidateEmail}`,
          member,
          team,
        ),
      }
    }

    if (yield* github.isUserSuspended(matchedUser.login)) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: createEdgeCase(
          'suspended-account',
          `GitHub user ${matchedUser.login} is suspended`,
          member,
          team,
        ),
      }
    }

    return {
      adoIdentity: member,
      githubUser: matchedUser,
      mapped: true,
    }
  })
}
