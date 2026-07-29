import type {MappingResult, MigrationReport, UserMappingResult} from '../types/index.js'

function escapeCell(value: string | number | boolean | undefined): string {
  if (value === undefined) {
    return ''
  }
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function toTable(headers: string[], rows: string[][], emptyMessage: string): string {
  if (rows.length === 0) {
    return `${emptyMessage}\n`
  }

  const headerRow = `| ${headers.map(escapeCell).join(' | ')} |`
  const divider = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`).join('\n')
  return `${headerRow}\n${divider}\n${body}\n`
}

function countMappedMembers(mappings: MappingResult[]): number {
  return mappings.reduce(
    (total, mapping) => total + mapping.memberMappings.filter((member) => member.mapped).length,
    0,
  )
}

function memberRows(memberMappings: UserMappingResult[]): string[][] {
  return memberMappings.map((member) => [
    member.adoIdentity.displayName,
    member.adoIdentity.uniqueName,
    member.githubUser?.login ?? '',
    member.mapped ? 'yes' : 'no',
    member.edgeCase?.reason ?? '',
  ])
}

export class MarkdownReporter {
  public render(report: MigrationReport, durationMs = 0): string {
    const teamCount = report.mappings.length
    const memberCount = countMappedMembers(report.mappings)

    const mappedTeamsRows = report.mappings.map((mapping) => [
      (mapping.sourceAdoTeams ?? [mapping.adoTeam]).map((team) => team.name).join(', '),
      mapping.githubTeam.slug,
      mapping.memberMappings.filter((member) => member.mapped).length.toString(),
      mapping.edgeCases.length.toString(),
    ])

    const hierarchyRows =
      report.teamPlan?.map((planned) => [
        planned.kind,
        planned.team.slug,
        planned.parentSlug ?? '',
        planned.sourceAdoTeamIds.join(', '),
      ]) ?? []

    const repositoryGrantRows =
      report.repositoryGrants?.map((grant) => [
        grant.repository,
        grant.teamSlug,
        grant.role,
        grant.basePermission,
        grant.visibility,
      ]) ?? []

    const edgeCaseRows = report.edgeCases.map((edge) => [
      edge.adoIdentity?.displayName ?? 'Unknown',
      edge.adoTeam?.name ?? '',
      edge.reason,
      edge.recommendation,
    ])

    const skippedRows = report.skippedItems.map((item) => [item.type, item.name, item.reason])

    const failureRows = report.failureLog.map((entry) => [
      entry.failureMode,
      entry.error,
      entry.healingAction,
      entry.userApproved === undefined ? '' : String(entry.userApproved),
      String(entry.resolved),
    ])

    const approvalRows = report.approvalHistory.map((entry) => [
      entry.action,
      entry.context,
      String(entry.approved),
      entry.timestamp,
    ])

    const sandboxRows =
      report.sandbox?.transcript.map((entry) => [
        String(entry.sequence),
        entry.fixtureId,
        entry.operation,
        entry.arguments,
        entry.outcome,
      ]) ?? []

    const memberSections = report.mappings
      .map((mapping) => {
        const rows = memberRows(mapping.memberMappings)
        return `### ${mapping.adoTeam.name}\n\n${toTable(
          ['ADO Member', 'UPN', 'GitHub Login', 'Mapped', 'Edge Case'],
          rows,
          '_No members found._',
        )}`
      })
      .join('\n')

    return [
      '# Team Migration Report',
      '',
      ...(report.sandbox
        ? [
            '> [!WARNING]',
            '> **SANDBOX — NO PROVIDER WRITES WERE PERFORMED.** All ADO, Entra, and GitHub responses were supplied by an editable scenario fixture.',
            '',
            `- **Sandbox Scenario:** ${report.sandbox.scenario} — ${report.sandbox.title}`,
            `- **Config SHA-256:** ${report.sandbox.configDigest}`,
            '',
          ]
        : []),
      '## Run Summary',
      '',
      `- **Run ID:** ${report.runId}`,
      `- **Timestamp:** ${report.timestamp}`,
      `- **ADO Org:** ${report.adoOrg}`,
      `- **ADO Project:** ${report.adoProject}`,
      `- **GitHub Org:** ${report.githubOrg}`,
      `- **Mode:** ${report.dryRun ? 'Dry Run' : 'Apply'}`,
      `- **Teams:** ${teamCount}`,
      `- **Members Mapped:** ${memberCount}`,
      `- **Edge Cases:** ${report.edgeCases.length}`,
      `- **Duration:** ${(durationMs / 1000).toFixed(1)}s`,
      '',
      '## Mapped Teams',
      '',
      toTable(
        ['Source ADO Team(s)', 'GitHub Slug', 'Members Mapped', 'Edge Cases'],
        mappedTeamsRows,
        '_No team mappings generated._',
      ),
      ...(report.teamPlan && report.teamPlan.some((team) => team.kind !== 'flat')
        ? [
            '## Planned Team Hierarchy',
            '',
            '> Structural parent teams receive no repository grants. Child teams inherit any access later added to an ancestor, so audit parent access before and after migration.',
            '',
            toTable(
              ['Kind', 'GitHub Slug', 'Parent Slug', 'Source ADO Team IDs'],
              hierarchyRows,
              '_No hierarchy planned._',
            ),
            '## Planned Direct Repository Grants',
            '',
            '> These are direct team grants, not a complete calculation of effective access. Organization base permissions, enterprise policies, direct collaborators, outside collaborators, other teams, and custom roles can widen access.',
            '',
            toTable(
              ['Repository', 'Team', 'Direct Role', 'Organization Base', 'Visibility'],
              repositoryGrantRows,
              '_No repository grants planned._',
            ),
          ]
        : []),
      '## Member Mapping Details',
      '',
      memberSections.length > 0 ? memberSections : '_No member mappings available._',
      '',
      '## Edge Cases',
      '',
      toTable(
        ['Identity', 'Team', 'Reason', 'Recommendation'],
        edgeCaseRows,
        '_No edge cases detected._',
      ),
      '## Skipped Items',
      '',
      toTable(['Type', 'Name', 'Reason'], skippedRows, '_No skipped items._'),
      '## Failure Log',
      '',
      toTable(
        ['Failure Mode', 'Error', 'Healing Action', 'User Approved', 'Resolved'],
        failureRows,
        '_No failures logged._',
      ),
      '## Approval History',
      '',
      toTable(['Action', 'Context', 'Approved', 'Timestamp'], approvalRows, '_No approvals recorded._'),
      ...(report.sandbox
        ? [
            '## Sandbox Boundary Transcript',
            '',
            toTable(
              ['#', 'Fixture', 'Operation', 'Arguments', 'Outcome'],
              sandboxRows,
              '_No sandbox boundary calls recorded._',
            ),
          ]
        : []),
    ].join('\n')
  }
}
