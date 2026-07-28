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
      mapping.adoTeam.name,
      mapping.githubTeam.slug,
      mapping.memberMappings.filter((member) => member.mapped).length.toString(),
      mapping.edgeCases.length.toString(),
    ])

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
        ['ADO Team', 'GitHub Slug', 'Members Mapped', 'Edge Cases'],
        mappedTeamsRows,
        '_No team mappings generated._',
      ),
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
    ].join('\n')
  }
}
