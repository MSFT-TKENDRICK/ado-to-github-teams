interface TaggedFailure {
  readonly _tag: string
  readonly message?: string
  readonly status?: number
  readonly ssoRequired?: boolean
  readonly correctedCommand?: string
}

export interface RecoveryGuidance {
  readonly summary: string
  readonly problem: string
  readonly state: string
  readonly nextSteps: ReadonlyArray<string>
  readonly technicalDetails: string
}

function taggedFailure(error: unknown): TaggedFailure | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('_tag' in error) ||
    typeof error._tag !== 'string'
  ) {
    return undefined
  }
  return {
    _tag: error._tag,
    ...('message' in error && typeof error.message === 'string' ? {message: error.message} : {}),
    ...('status' in error && typeof error.status === 'number' ? {status: error.status} : {}),
    ...('ssoRequired' in error && typeof error.ssoRequired === 'boolean'
      ? {ssoRequired: error.ssoRequired}
      : {}),
    ...('correctedCommand' in error && typeof error.correctedCommand === 'string'
      ? {correctedCommand: error.correctedCommand}
      : {}),
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  const tagged = taggedFailure(error)
  return tagged?.message ?? String(error)
}

function technicalDetails(error: unknown): string {
  const tagged = taggedFailure(error)
  if (tagged) {
    return [tagged._tag, tagged.status === undefined ? undefined : `HTTP ${tagged.status}`]
      .filter(Boolean)
      .join(' | ')
  }
  return error instanceof Error ? error.name : typeof error
}

function stateGuidance(argv: ReadonlyArray<string>): string {
  if (argv.some((argument) => argument === '--sandbox' || argument.startsWith('--sandbox='))) {
    return 'Sandbox provider writes are simulated; restart the scenario from its fixture state after correcting the problem.'
  }
  if (argv.includes('--apply')) {
    return 'Do not start with --fresh. Reopen the durable session so checkpointed writes are reconciled before any retry.'
  }
  return 'Dry-run is the default, so no target writes are expected. If a durable session started, reopening it preserves the recorded progress.'
}

function nextSteps(error: unknown): ReadonlyArray<string> {
  if (isUnknownCommandError(error)) {
    return [
      'Run `ado-to-github-teams --help` to choose a command by operator task.',
      'Preview safely with `ado-to-github-teams migrate --ado-org <url> --ado-project <project> --github-org <org> --foreground`.',
      'Reopen the latest durable migration with `ado-to-github-teams` (no arguments).',
    ]
  }
  const tagged = taggedFailure(error)
  if (tagged?._tag === 'MigrationCommandPreflightFailure' && tagged.correctedCommand) {
    return [
      'No provider or worker access occurred because command preflight failed.',
      `Run the corrected shape: \`${tagged.correctedCommand}\`.`,
    ]
  }
  if (tagged?._tag === 'AuthenticationFailure') {
    return [
      'Run `ado-to-github-teams auth` to identify the credential that needs attention.',
      'After authentication succeeds, run `ado-to-github-teams` to reopen the latest migration session.',
    ]
  }
  if (tagged?._tag === 'PermissionFailure') {
    return tagged.ssoRequired
      ? [
          'Authorize the GitHub credential for SAML SSO in the target organization.',
          'Run `ado-to-github-teams` to reopen the latest migration session; do not use --fresh.',
        ]
      : [
          'Grant only the missing provider permission described above.',
          'Run `ado-to-github-teams` to reopen the latest migration session; do not use --fresh.',
        ]
  }
  if (tagged?._tag === 'TransientFailure') {
    return [
      'Wait for the provider retry interval before continuing.',
      'Run `ado-to-github-teams` to reopen the latest migration session; completed writes will be reconciled.',
    ]
  }
  if (tagged?._tag === 'WorkflowWorkerFailure') {
    return tagged.status === 401 || tagged.status === 403
      ? [
          'Validate WORKFLOW_API_TOKEN through Varlock and confirm the CLI and worker use the same value.',
          'Run `ado-to-github-teams` after worker authentication succeeds.',
        ]
      : [
          'Confirm the durable worker is reachable at the configured --worker-url.',
          'Run `ado-to-github-teams` to reopen the latest migration session after the worker is healthy.',
        ]
  }
  if (
    tagged &&
    ['ValidationFailure', 'DecodeFailure', 'ConflictFailure', 'NotFoundFailure'].includes(
      tagged._tag,
    )
  ) {
    return [
      'Correct the named input, mapping, or target conflict before continuing.',
      'Re-run a dry-run and review its report before approving target writes.',
    ]
  }
  if (/WORKFLOW_API_TOKEN/.test(errorMessage(error))) {
    return [
      'Configure WORKFLOW_API_TOKEN with at least 32 characters through Varlock.',
      'Restart the worker with the same token, then run `ado-to-github-teams`.',
    ]
  }
  return [
    'Run `ado-to-github-teams sessions --blocked` to check for a decision awaiting the operator.',
    'Run `ado-to-github-teams` to inspect or reopen the latest durable migration session.',
  ]
}

export function recoveryGuidance(error: unknown, argv: ReadonlyArray<string>): RecoveryGuidance {
  return {
    summary: 'Migration could not continue.',
    problem: errorMessage(error),
    state: stateGuidance(argv),
    nextSteps: nextSteps(error),
    technicalDetails: technicalDetails(error),
  }
}

export function renderRecoveryGuidance(error: unknown, argv: ReadonlyArray<string>): string {
  const guidance = recoveryGuidance(error, argv)
  return [
    guidance.summary,
    '',
    `Problem: ${guidance.problem}`,
    `State: ${guidance.state}`,
    '',
    'Safe next steps:',
    ...guidance.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `Technical details: ${guidance.technicalDetails}`,
  ].join('\n')
}
import {isUnknownCommandError} from './command-guidance.js'
