import {Schema} from 'effect'
import type {TeamTopologyConfig} from '../../types/index.js'

const RepositoryRoleSchema = Schema.Literal('read', 'triage', 'write', 'maintain', 'admin')

export const TeamTopologyConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  organizationalUnit: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  projectTeam: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
  repositories: Schema.Array(
    Schema.Struct({
      repository: Schema.String,
      teamName: Schema.String,
      description: Schema.optional(Schema.String),
      sourceAdoTeams: Schema.Array(Schema.String),
      role: RepositoryRoleSchema,
    }),
  ),
  allowAdmin: Schema.optional(Schema.Boolean),
})

export function topologyValidationMessage(config: TeamTopologyConfig): string | null {
  if (config.organizationalUnit.name.trim().length === 0) {
    return 'organizationalUnit.name must not be blank.'
  }
  if (config.repositories.length === 0) {
    return 'A team topology must contain at least one repository mapping.'
  }
  for (const repository of config.repositories) {
    if (repository.repository.trim().length === 0) {
      return 'repositories[].repository must not be blank.'
    }
    if (repository.teamName.trim().length === 0) {
      return 'repositories[].teamName must not be blank.'
    }
    if (repository.sourceAdoTeams.length === 0) {
      return `Repository ${repository.repository} must name at least one source ADO team.`
    }
    if (repository.sourceAdoTeams.some((team) => team.trim().length === 0)) {
      return 'repositories[].sourceAdoTeams[] must not be blank.'
    }
    if (repository.role === 'admin' && config.allowAdmin !== true) {
      return `Repository ${repository.repository} requests admin access but allowAdmin is not true.`
    }
  }
  return null
}
