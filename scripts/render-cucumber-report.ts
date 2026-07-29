import {readdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {parseEnvelope, TestStepResultStatus, type Duration} from '@cucumber/messages'
import {Query} from '@cucumber/query'

interface ScenarioSummary {
  feature: string
  scenario: string
  status: string
  durationMs: number
}

const OFFICIAL_SOURCES = [
  {
    label: 'GitHub Enterprise Managed Users',
    url: 'https://docs.github.com/en/enterprise-cloud@latest/admin/concepts/identity-and-access-management/enterprise-managed-users',
  },
  {
    label: 'GitHub team synchronization',
    url: 'https://docs.github.com/en/enterprise-cloud@latest/organizations/organizing-members-into-teams/synchronizing-a-team-with-an-identity-provider-group',
  },
  {
    label: 'GitHub REST API best practices',
    url: 'https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api',
  },
  {
    label: 'Microsoft Graph transitive group members',
    url: 'https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers?view=graph-rest-1.0',
  },
  {
    label: 'Azure DevOps team members REST API',
    url: 'https://learn.microsoft.com/en-us/rest/api/azure/devops/core/teams/get-team-members-with-extended-properties?view=azure-devops-rest-7.1',
  },
]

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function durationMilliseconds(duration: Duration | undefined): number {
  if (!duration) {
    return 0
  }
  return duration.seconds * 1000 + duration.nanos / 1_000_000
}

/**
 * Reads a Cucumber Messages NDJSON stream (one JSON-encoded Envelope per
 * line, produced by Cucumber's built-in `message` formatter) and replays
 * every envelope into a `@cucumber/query` Query, which assembles the
 * gherkinDocument/pickle/testCase/testCaseStarted/testStepFinished graph
 * needed to compute a pass/fail summary per scenario.
 */
async function loadQuery(messagesPath: string): Promise<Query> {
  const query = new Query()
  let raw: string
  try {
    raw = await readFile(messagesPath, 'utf8')
  } catch {
    // A missing or unreadable messages file yields an empty query, which
    // renders as a FAIL report below rather than throwing during CI.
    return query
  }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue
    }
    query.update(parseEnvelope(line))
  }
  return query
}

function summaries(query: Query): ScenarioSummary[] {
  return query.findAllTestCaseStarted().map((testCaseStarted) => {
    const pickle = query.findPickleBy(testCaseStarted)
    const lineage = pickle ? query.findLineageBy(pickle) : undefined
    const result = query.findMostSevereTestStepResultBy(testCaseStarted)
    const duration = query.findTestCaseDurationBy(testCaseStarted)
    return {
      feature: lineage?.feature?.name ?? 'Unnamed feature',
      scenario: pickle?.name ?? 'Unnamed scenario',
      status: (result?.status ?? TestStepResultStatus.UNKNOWN).toLowerCase(),
      durationMs: durationMilliseconds(duration),
    }
  })
}

async function featureFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return featureFiles(fullPath)
      }
      return entry.isFile() && entry.name.endsWith('.feature') ? [fullPath] : []
    }),
  )
  return nested.flat()
}

async function manualScenarios(directory: string): Promise<string[]> {
  const scenarios: string[] = []
  for (const file of await featureFiles(directory)) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
    let pendingTags: string[] = []
    let manualFeature = false
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (line.startsWith('@')) {
        pendingTags = line.split(/\s+/)
        continue
      }
      if (line.startsWith('Feature:')) {
        manualFeature = pendingTags.includes('@manual')
        pendingTags = []
        continue
      }
      const match = /^Scenario(?: Outline)?:\s+(.+)$/.exec(line)
      if (match) {
        if (manualFeature || pendingTags.includes('@manual')) {
          scenarios.push(match[1] ?? 'Unnamed manual scenario')
        }
        pendingTags = []
      }
    }
  }
  return scenarios
}

export async function renderCucumberReport(
  messagesPath: string,
  outputPath: string,
  featuresPath: string,
): Promise<void> {
  const query = await loadQuery(messagesPath)
  const automated = summaries(query)
  const manual = await manualScenarios(featuresPath)
  const passed = automated.filter((scenario) => scenario.status === 'passed').length
  const failed = automated.length - passed
  const outcome = automated.length > 0 && failed === 0 ? 'PASS' : 'FAIL'

  const automatedRows =
    automated.length > 0
      ? automated
          .map(
            (scenario) =>
              `| ${escapeCell(scenario.feature)} | ${escapeCell(scenario.scenario)} | ${scenario.status === 'passed' ? 'PASS' : 'FAIL'} | ${scenario.durationMs.toFixed(0)} ms |`,
          )
          .join('\n')
      : '| Cucumber execution | No machine-readable results were produced | FAIL | 0 ms |'

  const manualRows = manual.map((scenario) => `| ${escapeCell(scenario)} | Manual/live tenant |`).join('\n')
  const sourceRows = OFFICIAL_SOURCES.map(
    (source) => `- [${source.label}](${source.url})`,
  ).join('\n')

  const markdown = [
    '<!-- migration-bdd-report -->',
    '## Migration BDD acceptance report',
    '',
    `**${outcome}** - ${passed}/${automated.length} automated scenarios passed; ${manual.length} live-tenant scenarios are explicitly tracked.`,
    '',
    '| Feature | Scenario | Status | Duration |',
    '| --- | --- | --- | --- |',
    automatedRows,
    '',
    '<details>',
    '<summary>Manual and external-behavior coverage</summary>',
    '',
    'These scenarios are intentionally excluded from mocked CI because SCIM ownership, SSO lifecycle, provider throttling, and eventual consistency require a controlled enterprise tenant.',
    '',
    '| Scenario | Verification |',
    '| --- | --- |',
    manualRows,
    '',
    '</details>',
    '',
    '<details>',
    '<summary>Official documentation used</summary>',
    '',
    sourceRows,
    '',
    '</details>',
    '',
    '_The PR comment contains synthetic test outcomes only; migration reports and tenant identity data are not published._',
    '',
  ].join('\n')

  await writeFile(outputPath, markdown, 'utf8')
}
