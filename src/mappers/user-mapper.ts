import {EntraService} from '../services/entra.js'
import {GitHubService} from '../services/github.js'
import type {
  AdoMember,
  EdgeCase,
  EdgeCaseReason,
  EntraIdentity,
  UserMappingResult,
} from '../types/index.js'
import {AmbiguousMatchError} from '../utils/errors.js'

const RECOMMENDATIONS: Record<EdgeCaseReason, string> = {
  'no-ghemu-account': 'Invite user to GitHub org as GHEMU user',
  'guest-user': 'Guest accounts cannot be GHEMU users; create a GitHub.com account manually',
  'disabled-account': 'Enable the user in Entra and provision the account before migrating',
  'unresolved-identity':
    'Resolve the Azure DevOps identity to an active Entra user before migrating',
  'suspended-account': 'Reactivate user in GitHub before migrating',
  'ambiguous-match': 'Multiple GitHub users match this email; specify login manually',
  'missing-email': 'User has no verified email in Entra; add email to Entra profile',
  'circular-group-member': 'Remove circular group reference in Entra before migrating',
  'entra-role-only': 'Service account or role; create corresponding GitHub bot/team manually',
  'ado-project-role':
    'ADO project roles (Project Admin, Build Admin) have no GitHub equivalent; assign GitHub team maintainer role manually',
  'nested-group-skipped': 'Nested group exceeded depth limit; enumerate group members manually',
}

function edge(
  reason: EdgeCaseReason,
  details: string,
  adoIdentity?: AdoMember | EntraIdentity,
): EdgeCase {
  const result: EdgeCase = {
    reason,
    details,
    recommendation: RECOMMENDATIONS[reason],
  }
  if (adoIdentity) {
    result.adoIdentity = adoIdentity
  }
  return result
}

function roleLike(displayName: string): boolean {
  return /(project|build|release).*(admin|administrator|role)/i.test(displayName)
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export class UserMapper {
  public constructor(
    private readonly githubService: GitHubService,
    private readonly entraService: EntraService,
  ) {}

  public async mapMember(member: AdoMember): Promise<UserMappingResult> {
    if (member.isContainer) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'nested-group-skipped',
          `Group ${member.displayName} should be expanded by TeamMapper before user mapping.`,
          member,
        ),
      }
    }

    if (roleLike(member.displayName)) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'ado-project-role',
          `Member "${member.displayName}" appears to be an ADO role assignment.`,
          member,
        ),
      }
    }

    if (!member.uniqueName.includes('@') && !member.email) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'entra-role-only',
          `Identity "${member.displayName}" has no UPN/email and appears role-backed.`,
          member,
        ),
      }
    }

    let identity = await this.entraService.resolveUserByUpn(member.uniqueName)
    if (!identity && member.email) {
      identity = await this.entraService.resolveUserByUpn(member.email)
    }

    if (!identity) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'unresolved-identity',
          `No Entra identity found for ${member.displayName}.`,
          member,
        ),
      }
    }
    if (identity?.isGuest) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'guest-user',
          `Entra identity ${identity.userPrincipalName} is a guest user.`,
          identity,
        ),
      }
    }
    if (identity.accountEnabled === false) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'disabled-account',
          `Entra identity ${identity.userPrincipalName} is disabled.`,
          identity,
        ),
      }
    }

    const mappedEmail = identity.mail ?? identity.userPrincipalName
    if (!mappedEmail || !isValidEmail(mappedEmail)) {
      return {
        adoIdentity: member,
        mapped: false,
        edgeCase: edge(
          'missing-email',
          `No mappable email found for ${member.displayName}.`,
          member,
        ),
      }
    }

    try {
      const githubUser = await this.githubService.findUserByEmail(mappedEmail)
      if (!githubUser) {
        return {
          adoIdentity: member,
          mapped: false,
          edgeCase: edge(
            'no-ghemu-account',
            `No GitHub Enterprise Managed User matches ${mappedEmail}.`,
            identity ?? member,
          ),
        }
      }

      const suspended = await this.githubService.isUserSuspended(githubUser.login)
      if (suspended) {
        return {
          adoIdentity: member,
          mapped: false,
          edgeCase: edge(
            'suspended-account',
            `GitHub user ${githubUser.login} is suspended.`,
            identity ?? member,
          ),
        }
      }

      return {
        adoIdentity: member,
        githubUser,
        mapped: true,
      }
    } catch (error) {
      if (error instanceof AmbiguousMatchError) {
        return {
          adoIdentity: member,
          mapped: false,
          edgeCase: edge(
            'ambiguous-match',
            `Email ${mappedEmail} matches multiple users: ${error.candidates.join(', ')}`,
            identity ?? member,
          ),
        }
      }
      throw error
    }
  }

  public async mapGroupMember(
    groupMember: AdoMember,
  ): Promise<{memberMappings: UserMappingResult[]; edgeCases: EdgeCase[]}> {
    try {
      const identities = await this.entraService.getGroupMembers(
        groupMember.descriptor ?? groupMember.id,
        true,
      )

      const memberMappings: UserMappingResult[] = []
      const edgeCases: EdgeCase[] = []
      for (const identity of identities) {
        const candidate: AdoMember = {
          id: identity.id,
          displayName: identity.displayName,
          uniqueName: identity.userPrincipalName,
          isContainer: false,
        }
        if (identity.mail) {
          candidate.email = identity.mail
        }
        const mapped = await this.mapMember(candidate)
        memberMappings.push(mapped)
        if (mapped.edgeCase) {
          edgeCases.push(mapped.edgeCase)
        }
      }

      return {memberMappings, edgeCases}
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'CIRCULAR_GROUP'
          ? 'circular-group-member'
          : 'nested-group-skipped'
      return {
        memberMappings: [],
        edgeCases: [
          edge(
            reason,
            error instanceof Error ? error.message : 'Failed to expand group member.',
            groupMember,
          ),
        ],
      }
    }
  }
}
