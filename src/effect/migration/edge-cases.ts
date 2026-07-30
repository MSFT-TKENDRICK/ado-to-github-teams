import type {AdoMember, AdoTeam, EdgeCase, EdgeCaseReason} from '../../types/index.js'
import {edgeCaseRecommendation} from '../../ui/plain-language.js'

export function createEdgeCase(
  reason: EdgeCaseReason,
  details: string,
  adoIdentity?: AdoMember,
  adoTeam?: AdoTeam,
): EdgeCase {
  return {
    reason,
    details,
    recommendation: edgeCaseRecommendation(reason),
    ...(adoIdentity ? {adoIdentity} : {}),
    ...(adoTeam ? {adoTeam} : {}),
  }
}

export function isProjectRole(displayName: string): boolean {
  return /(project|build|release).*(admin|administrator|role)/i.test(displayName)
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
