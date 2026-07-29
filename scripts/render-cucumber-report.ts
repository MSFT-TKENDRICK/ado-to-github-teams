import {readdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'

interface CucumberResult {
  status?: string
  duration?: unknown
}

interface CucumberStep {
  result?: CucumberResult
}

interface CucumberScenario {
  name?: string
  type?: string
  steps?: CucumberStep[]
}

interface CucumberFeature {
  name?: string
  elements?: CucumberScenario[]
}

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

function durationMilliseconds(value: unknown): number {
  if (typeof value === 'number') {
    return value / 1_000_000
  }
  if (typeof value === 'object' && value !== null) {
    const duration = value as {seconds?: unknown; nanos?: unknown}
    const seconds = typeof duration.seconds === 'number' ? duration.seconds : 0
    const nanos = typeof duration.nanos === 'number' ? duration.nanos : 0
    return seconds * 1000 + nanos / 1_000_000
  }
  return 0
}

function scenarioStatus(steps: CucumberStep[]): string {
  const statuses = steps.map((step) => step.result?.status?.toLowerCase() ?? 'unknown')
  return statuses.every((status) => status === 'passed') ? 'passed' : statuses.find((status) => status !== 'passed') ?? 'unknown'
}

function summaries(features: CucumberFeature[]): ScenarioSummary[] {
  return features.flatMap((feature) =>
    (feature.elements ?? [])
      .filter((scenario) => scenario.type === 'scenario')
      .map((scenario) => {
        const steps = scenario.steps ?? []
        return {
          feature: feature.name ?? 'Unnamed feature',
          scenario: scenario.name ?? 'Unnamed scenario',
          status: scenarioStatus(steps),
          durationMs: steps.reduce(
            (total, step) => total + durationMilliseconds(step.result?.duration),
            0,
          ),
        }
      }),
  )
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
  jsonPath: string,
  outputPath: string,
  featuresPath: string,
): Promise<void> {
  let features: CucumberFeature[] = []
  try {
    features = JSON.parse(await readFile(jsonPath, 'utf8')) as CucumberFeature[]
  } catch {
    features = []
  }

  const automated = summaries(features)
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
