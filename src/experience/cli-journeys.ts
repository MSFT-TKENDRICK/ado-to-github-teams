import {Schema} from 'effect'

export const CliJourneyLeverSchema = Schema.Literal(
  'statusVisibility',
  'plainLanguage',
  'recoveryGuidance',
  'approvalContext',
  'adaptiveDetail',
  'confirmationClosure',
  'commandDiscoverability',
  'flagErgonomics',
  'scopeRepetition',
  'automationClarity',
  'credentialSetup',
  'errorPrevention',
)

export type CliJourneyLever = Schema.Schema.Type<typeof CliJourneyLeverSchema>

export const CliCommandSchema = Schema.Literal('migrate', 'auth', 'sessions')
export type CliCommand = Schema.Schema.Type<typeof CliCommandSchema>

export const CliEntrypointSchema = Schema.Literal(
  'no-args',
  'explicit-command',
  'root-sandbox-routing',
  'root-help',
  'root-version',
  'unknown-command',
)
export type CliEntrypoint = Schema.Schema.Type<typeof CliEntrypointSchema>

export const CliConflictSchema = Schema.Literal(
  'sandbox-config-dependency',
  'topology-prefix-conflict',
  'topology-suffix-conflict',
  'fresh-resume-conflict',
  'sandbox-topology-conflict',
  'sandbox-resume-conflict',
  'sandbox-apply-required',
  'sandbox-dry-run-apply-conflict',
  'live-yes-conflict',
)
export type CliConflict = Schema.Schema.Type<typeof CliConflictSchema>

const CliCoverageManifestSchema = Schema.Struct({
  entrypoints: Schema.Array(CliEntrypointSchema),
  commands: Schema.Array(
    Schema.Struct({
      command: CliCommandSchema,
      flags: Schema.Array(Schema.String),
    }),
  ),
  conflicts: Schema.Array(CliConflictSchema),
})

const CliJourneySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  personas: Schema.Array(Schema.String),
  entrypoint: CliEntrypointSchema,
  command: Schema.Literal('root', 'migrate', 'auth', 'sessions'),
  flags: Schema.Array(Schema.String),
  conflicts: Schema.Array(CliConflictSchema),
  expectedOutcome: Schema.Literal('success', 'help', 'version', 'prevented-error'),
  steps: Schema.Array(
    Schema.Struct({
      action: Schema.String,
      lever: CliJourneyLeverSchema,
    }),
  ),
})

export type CliJourney = Schema.Schema.Type<typeof CliJourneySchema>

export const CLI_COVERAGE_MANIFEST = Schema.decodeUnknownSync(CliCoverageManifestSchema)({
  entrypoints: [
    'no-args',
    'explicit-command',
    'root-sandbox-routing',
    'root-help',
    'root-version',
    'unknown-command',
  ],
  commands: [
    {
      command: 'migrate',
      flags: [
        '--ado-org',
        '--ado-project',
        '--github-org',
        '--apply',
        '--output',
        '--detail',
        '--prefix',
        '--suffix',
        '--yes',
        '--resume',
        '--fresh',
        '--foreground',
        '--sessions',
        '--concurrency',
        '--team-topology',
        '--worker-url',
        '--sandbox',
        '--sandbox-config',
        '--list-sandbox-scenarios',
      ],
    },
    {command: 'auth', flags: ['--ado-org', '--quiet']},
    {
      command: 'sessions',
      flags: ['--blocked', '--json', '--select', '--detail', '--worker-url'],
    },
  ],
  conflicts: [
    'sandbox-config-dependency',
    'topology-prefix-conflict',
    'topology-suffix-conflict',
    'fresh-resume-conflict',
    'sandbox-topology-conflict',
    'sandbox-resume-conflict',
    'sandbox-apply-required',
    'sandbox-dry-run-apply-conflict',
    'live-yes-conflict',
  ],
})

export const CLI_JOURNEYS = Schema.decodeUnknownSync(Schema.Array(CliJourneySchema))([
  {
    id: 'reopen-latest-with-no-arguments',
    title: 'Reopen the latest migration from the default entrypoint',
    personas: ['first-time-coordinator', 'incident-recovery-operator'],
    entrypoint: 'no-args',
    command: 'migrate',
    flags: [],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {
        action: 'invoke the CLI without a command or flags',
        lever: 'commandDiscoverability',
      },
      {
        action: 'recognize that the latest compatible migration session is reopened',
        lever: 'statusVisibility',
      },
    ],
  },
  {
    id: 'discover-root-help',
    title: 'Discover commands and safe starting points from root help',
    personas: ['first-time-coordinator', 'infrequent-low-bandwidth-operator'],
    entrypoint: 'root-help',
    command: 'root',
    flags: [],
    conflicts: [],
    expectedOutcome: 'help',
    steps: [
      {action: 'request root help', lever: 'commandDiscoverability'},
      {
        action: 'compare migrate, auth, and sessions without provider access',
        lever: 'plainLanguage',
      },
    ],
  },
  {
    id: 'inspect-version',
    title: 'Read the installed CLI version for automation diagnostics',
    personas: ['unattended-automation-engineer', 'incident-recovery-operator'],
    entrypoint: 'root-version',
    command: 'root',
    flags: [],
    conflicts: [],
    expectedOutcome: 'version',
    steps: [
      {action: 'request the CLI version', lever: 'automationClarity'},
      {action: 'record the version in diagnostic evidence', lever: 'confirmationClosure'},
    ],
  },
  {
    id: 'discover-migrate-help',
    title: 'Inspect migration scope, execution, recovery, and sandbox flags',
    personas: ['first-time-coordinator', 'time-pressured-engineer'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: [],
    conflicts: [],
    expectedOutcome: 'help',
    steps: [
      {action: 'request help for the migrate command', lever: 'commandDiscoverability'},
      {action: 'compare valid flag groups and examples', lever: 'flagErgonomics'},
    ],
  },
  {
    id: 'discover-auth-help',
    title: 'Inspect credential validation options before resolving credentials',
    personas: ['security-credential-administrator', 'first-time-coordinator'],
    entrypoint: 'explicit-command',
    command: 'auth',
    flags: [],
    conflicts: [],
    expectedOutcome: 'help',
    steps: [
      {action: 'request help for the auth command', lever: 'commandDiscoverability'},
      {action: 'identify interactive and quiet validation paths', lever: 'credentialSetup'},
    ],
  },
  {
    id: 'discover-sessions-help',
    title: 'Inspect session filtering, selection, detail, and JSON options',
    personas: ['incident-recovery-operator', 'nonvisual-operator'],
    entrypoint: 'explicit-command',
    command: 'sessions',
    flags: [],
    conflicts: [],
    expectedOutcome: 'help',
    steps: [
      {action: 'request help for the sessions command', lever: 'commandDiscoverability'},
      {action: 'compare human and machine-readable inbox paths', lever: 'automationClarity'},
    ],
  },
  {
    id: 'reject-unknown-command',
    title: 'Prevent an unknown command and point back to discoverable help',
    personas: ['first-time-coordinator', 'infrequent-low-bandwidth-operator'],
    entrypoint: 'unknown-command',
    command: 'root',
    flags: [],
    conflicts: [],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'enter an unknown command', lever: 'errorPrevention'},
      {action: 'read the correction and help route', lever: 'commandDiscoverability'},
    ],
  },
  {
    id: 'preview-scoped-migration',
    title: 'Preview a scoped migration with explicit naming and output controls',
    personas: ['first-time-coordinator', 'risk-accountable-owner'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: [
      '--ado-org',
      '--ado-project',
      '--github-org',
      '--output',
      '--detail',
      '--prefix',
      '--suffix',
      '--concurrency',
    ],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'enter source and target scope flags', lever: 'scopeRepetition'},
      {action: 'set guided detail and a report output path', lever: 'flagErgonomics'},
      {action: 'set team prefix, suffix, and bounded concurrency', lever: 'errorPrevention'},
      {action: 'review the dry-run outcome receipt', lever: 'confirmationClosure'},
    ],
  },
  {
    id: 'reject-unattended-apply',
    title: 'Reject noninteractive approval for a live migration',
    personas: ['unattended-automation-engineer', 'risk-accountable-owner'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--apply', '--yes', '--fresh', '--worker-url'],
    conflicts: ['live-yes-conflict'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'select apply and fresh session behavior explicitly', lever: 'errorPrevention'},
      {action: 'provide the worker URL for automation', lever: 'automationClarity'},
      {action: 'request noninteractive approval behavior', lever: 'approvalContext'},
      {action: 'receive prevention before provider access or writes', lever: 'confirmationClosure'},
    ],
  },
  {
    id: 'resume-in-foreground',
    title: 'Resume an interrupted migration and wait for completion',
    personas: ['incident-recovery-operator', 'time-pressured-engineer'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--resume', '--foreground'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'provide the retained run ID', lever: 'recoveryGuidance'},
      {action: 'choose foreground waiting', lever: 'flagErgonomics'},
      {action: 'track the resumed stage and next event', lever: 'statusVisibility'},
    ],
  },
  {
    id: 'open-session-inbox-from-migrate',
    title: 'Open the session inbox from the migration journey',
    personas: ['incident-recovery-operator', 'nonvisual-operator'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--sessions'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'switch from migration to the session inbox', lever: 'commandDiscoverability'},
      {action: 'scan blocking decisions and next events', lever: 'statusVisibility'},
    ],
  },
  {
    id: 'run-topology-plan',
    title: 'Run a migration with an exact topology plan',
    personas: ['time-pressured-engineer', 'risk-accountable-owner'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--team-topology'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'provide the topology plan path', lever: 'flagErgonomics'},
      {action: 'review exact hierarchy and repository grants', lever: 'approvalContext'},
    ],
  },
  {
    id: 'route-root-sandbox',
    title: 'Route a root sandbox flag to the migrate command',
    personas: ['first-time-coordinator', 'security-credential-administrator'],
    entrypoint: 'root-sandbox-routing',
    command: 'migrate',
    flags: ['--sandbox'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {
        action: 'invoke a sandbox scenario without an explicit command',
        lever: 'commandDiscoverability',
      },
      {action: 'confirm that all provider boundaries are simulated', lever: 'errorPrevention'},
    ],
  },
  {
    id: 'list-custom-sandbox-catalog',
    title: 'List scenarios from a custom sandbox catalog',
    personas: ['time-pressured-engineer', 'infrequent-low-bandwidth-operator'],
    entrypoint: 'root-sandbox-routing',
    command: 'migrate',
    flags: ['--sandbox-config', '--list-sandbox-scenarios'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'provide an editable sandbox catalog', lever: 'flagErgonomics'},
      {action: 'list available scenarios without provider calls', lever: 'commandDiscoverability'},
    ],
  },
  {
    id: 'validate-credentials',
    title: 'Validate all configured credentials against an ADO organization',
    personas: ['security-credential-administrator', 'first-time-coordinator'],
    entrypoint: 'explicit-command',
    command: 'auth',
    flags: ['--ado-org'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'choose the authentication command', lever: 'commandDiscoverability'},
      {action: 'provide the ADO organization used for validation', lever: 'scopeRepetition'},
      {
        action: 'interpret provider credential sources and corrective guidance',
        lever: 'credentialSetup',
      },
    ],
  },
  {
    id: 'validate-credentials-quietly',
    title: 'Validate credentials without success chatter in automation',
    personas: ['unattended-automation-engineer', 'security-credential-administrator'],
    entrypoint: 'explicit-command',
    command: 'auth',
    flags: ['--quiet'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'request quiet credential validation', lever: 'automationClarity'},
      {
        action: 'rely on exit status while preserving actionable failures',
        lever: 'credentialSetup',
      },
    ],
  },
  {
    id: 'scan-blocked-sessions-as-json',
    title: 'Scan blocked sessions as JSON through an explicit worker',
    personas: ['unattended-automation-engineer', 'incident-recovery-operator'],
    entrypoint: 'explicit-command',
    command: 'sessions',
    flags: ['--blocked', '--json', '--worker-url'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'filter the inbox to blocked sessions', lever: 'flagErgonomics'},
      {action: 'request JSON from the selected worker', lever: 'automationClarity'},
      {
        action: 'parse run IDs and blocking elicitations deterministically',
        lever: 'statusVisibility',
      },
    ],
  },
  {
    id: 'select-guided-session',
    title: 'Select a blocked session with guided detail',
    personas: ['first-time-coordinator', 'nonvisual-operator'],
    entrypoint: 'explicit-command',
    command: 'sessions',
    flags: ['--select', '--detail'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'request guided session detail', lever: 'adaptiveDetail'},
      {action: 'select and answer a blocking decision', lever: 'approvalContext'},
    ],
  },
  {
    id: 'scan-compact-sessions',
    title: 'Scan all sessions with compact detail',
    personas: ['time-pressured-engineer', 'infrequent-low-bandwidth-operator'],
    entrypoint: 'explicit-command',
    command: 'sessions',
    flags: ['--detail'],
    conflicts: [],
    expectedOutcome: 'success',
    steps: [
      {action: 'request compact session detail', lever: 'adaptiveDetail'},
      {action: 'scan line-oriented status in a constrained terminal', lever: 'statusVisibility'},
    ],
  },
  {
    id: 'prevent-orphan-sandbox-config',
    title: 'Reject sandbox config without a sandbox action',
    personas: ['first-time-coordinator'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--sandbox-config'],
    conflicts: ['sandbox-config-dependency'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'provide sandbox config without a scenario or list action', lever: 'flagErgonomics'},
      {
        action: 'receive the exact dependency correction before provider access',
        lever: 'errorPrevention',
      },
    ],
  },
  {
    id: 'prevent-topology-prefix',
    title: 'Reject topology with a name prefix',
    personas: ['risk-accountable-owner'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--team-topology', '--prefix'],
    conflicts: ['topology-prefix-conflict'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'combine exact topology names with a prefix', lever: 'flagErgonomics'},
      {action: 'prevent ambiguous target names before planning', lever: 'errorPrevention'},
    ],
  },
  {
    id: 'prevent-topology-suffix',
    title: 'Reject topology with a name suffix',
    personas: ['risk-accountable-owner'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--team-topology', '--suffix'],
    conflicts: ['topology-suffix-conflict'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'combine exact topology names with a suffix', lever: 'flagErgonomics'},
      {action: 'prevent ambiguous target names before planning', lever: 'errorPrevention'},
    ],
  },
  {
    id: 'prevent-fresh-resume',
    title: 'Reject mutually exclusive fresh and resume modes',
    personas: ['incident-recovery-operator'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--fresh', '--resume'],
    conflicts: ['fresh-resume-conflict'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'request both a new and retained session', lever: 'recoveryGuidance'},
      {action: 'prevent contradictory session behavior', lever: 'errorPrevention'},
    ],
  },
  {
    id: 'prevent-sandbox-topology',
    title: 'Reject topology plans in sandbox mode',
    personas: ['time-pressured-engineer'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--sandbox', '--team-topology'],
    conflicts: ['sandbox-topology-conflict'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'combine sandbox fixtures with a topology plan', lever: 'flagErgonomics'},
      {action: 'prevent an unsupported sandbox mode before execution', lever: 'errorPrevention'},
    ],
  },
  {
    id: 'prevent-sandbox-resume',
    title: 'Reject resume against fixture-backed sandbox state',
    personas: ['incident-recovery-operator'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--sandbox', '--resume'],
    conflicts: ['sandbox-resume-conflict'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'attempt to resume a sandbox fixture run', lever: 'recoveryGuidance'},
      {action: 'explain that fixture response queues start fresh', lever: 'errorPrevention'},
    ],
  },
  {
    id: 'require-apply-for-apply-sandbox',
    title: 'Require apply for an apply-mode sandbox scenario',
    personas: ['first-time-coordinator', 'risk-accountable-owner'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--sandbox'],
    conflicts: ['sandbox-apply-required'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'choose an apply-mode fixture without apply', lever: 'approvalContext'},
      {
        action: 'prevent a scenario mode mismatch while confirming writes remain simulated',
        lever: 'errorPrevention',
      },
    ],
  },
  {
    id: 'reject-apply-for-dry-run-sandbox',
    title: 'Reject apply for a dry-run sandbox scenario',
    personas: ['risk-accountable-owner', 'security-credential-administrator'],
    entrypoint: 'explicit-command',
    command: 'migrate',
    flags: ['--sandbox', '--apply'],
    conflicts: ['sandbox-dry-run-apply-conflict'],
    expectedOutcome: 'prevented-error',
    steps: [
      {action: 'apply a dry-run-only fixture', lever: 'approvalContext'},
      {action: 'prevent a scenario mode mismatch before orchestration', lever: 'errorPrevention'},
    ],
  },
])

export interface CliCoverageItem {
  readonly id: string
  readonly representedBy: ReadonlyArray<string>
  readonly covered: boolean
}

export interface CliCommandCoverage {
  readonly command: CliCommand
  readonly flags: ReadonlyArray<CliCoverageItem>
  readonly representedBy: ReadonlyArray<string>
  readonly covered: boolean
}

export interface CliCoverageReport {
  readonly commandCount: number
  readonly coveredCommandCount: number
  readonly flagCount: number
  readonly coveredFlagCount: number
  readonly entrypointCount: number
  readonly coveredEntrypointCount: number
  readonly conflictCount: number
  readonly coveredConflictCount: number
  readonly personaCount: number
  readonly coveredPersonaCount: number
  readonly commands: ReadonlyArray<CliCommandCoverage>
  readonly entrypoints: ReadonlyArray<CliCoverageItem>
  readonly conflicts: ReadonlyArray<CliCoverageItem>
  readonly personas: ReadonlyArray<CliCoverageItem>
  readonly failures: ReadonlyArray<string>
}

function coverageItem(
  id: string,
  journeys: ReadonlyArray<CliJourney>,
  predicate: (journey: CliJourney) => boolean,
): CliCoverageItem {
  const representedBy = journeys.filter(predicate).map((journey) => journey.id)
  return {id, representedBy, covered: representedBy.length > 0}
}

export function buildCliCoverageReport(
  journeys: ReadonlyArray<CliJourney>,
  personaIds: ReadonlyArray<string>,
): CliCoverageReport {
  const commands = CLI_COVERAGE_MANIFEST.commands.map(({command, flags}) => {
    const representedBy = journeys
      .filter((journey) => journey.command === command)
      .map((journey) => journey.id)
    return {
      command,
      representedBy,
      covered: representedBy.length > 0,
      flags: flags.map((flag) =>
        coverageItem(
          flag,
          journeys,
          (journey) => journey.command === command && journey.flags.includes(flag),
        ),
      ),
    }
  })
  const entrypoints = CLI_COVERAGE_MANIFEST.entrypoints.map((entrypoint) =>
    coverageItem(entrypoint, journeys, (journey) => journey.entrypoint === entrypoint),
  )
  const conflicts = CLI_COVERAGE_MANIFEST.conflicts.map((conflict) =>
    coverageItem(conflict, journeys, (journey) => journey.conflicts.includes(conflict)),
  )
  const personas = personaIds.map((personaId) =>
    coverageItem(personaId, journeys, (journey) => journey.personas.includes(personaId)),
  )
  const declaredFlags = new Map(
    CLI_COVERAGE_MANIFEST.commands.map(({command, flags}) => [command, new Set(flags)]),
  )
  const failures = [
    ...commands
      .filter((command) => !command.covered)
      .map((command) => `Command ${command.command} has no persona journey`),
    ...commands.flatMap((command) =>
      command.flags
        .filter((flag) => !flag.covered)
        .map((flag) => `${command.command} flag ${flag.id} has no persona journey`),
    ),
    ...entrypoints
      .filter((entrypoint) => !entrypoint.covered)
      .map((entrypoint) => `Entrypoint ${entrypoint.id} has no persona journey`),
    ...conflicts
      .filter((conflict) => !conflict.covered)
      .map((conflict) => `Conflict ${conflict.id} has no persona journey`),
    ...personas
      .filter((persona) => !persona.covered)
      .map((persona) => `Persona ${persona.id} has no CLI journey`),
    ...journeys
      .filter((journey) => journey.personas.length === 0)
      .map((journey) => `Journey ${journey.id} has no persona`),
    ...journeys.flatMap((journey) =>
      journey.personas
        .filter((personaId) => !personaIds.includes(personaId))
        .map((personaId) => `Journey ${journey.id} references unknown persona ${personaId}`),
    ),
    ...journeys.flatMap((journey) => {
      if (journey.command === 'root') {
        return journey.flags.map(
          (flag) => `Root journey ${journey.id} declares unsupported command flag ${flag}`,
        )
      }
      const knownFlags = declaredFlags.get(journey.command)
      return journey.flags
        .filter((flag) => !knownFlags?.has(flag))
        .map(
          (flag) => `Journey ${journey.id} references undeclared ${journey.command} flag ${flag}`,
        )
    }),
    ...journeys
      .filter((journey) => journey.steps.length === 0)
      .map((journey) => `Journey ${journey.id} has no modeled actions`),
  ]
  const flagItems = commands.flatMap((command) => command.flags)
  return {
    commandCount: commands.length,
    coveredCommandCount: commands.filter((command) => command.covered).length,
    flagCount: flagItems.length,
    coveredFlagCount: flagItems.filter((flag) => flag.covered).length,
    entrypointCount: entrypoints.length,
    coveredEntrypointCount: entrypoints.filter((entrypoint) => entrypoint.covered).length,
    conflictCount: conflicts.length,
    coveredConflictCount: conflicts.filter((conflict) => conflict.covered).length,
    personaCount: personas.length,
    coveredPersonaCount: personas.filter((persona) => persona.covered).length,
    commands,
    entrypoints,
    conflicts,
    personas,
    failures,
  }
}

export function cliJourneyObservations() {
  return CLI_JOURNEYS.map((journey) => ({
    feature: 'Complete CLI journeys',
    scenario: journey.title,
    status: 'passed',
    durationMs: 0,
    steps: journey.steps.map((step) => step.action),
    source: 'cli-journey' as const,
    personaIds: journey.personas,
    stepLevers: journey.steps.map((step) => step.lever),
    journey: {
      id: journey.id,
      entrypoint: journey.entrypoint,
      command: journey.command,
      flags: journey.flags,
      conflicts: journey.conflicts,
      expectedOutcome: journey.expectedOutcome,
    },
  }))
}
