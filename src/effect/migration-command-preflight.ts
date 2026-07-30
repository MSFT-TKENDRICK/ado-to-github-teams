import {Context, Effect, Layer, Schema} from 'effect'
import {MigrationCommandPreflightFailure} from './errors.js'
import {renderCliCommand} from '../ui/command-guidance.js'

const ScenarioModeSchema = Schema.Literal('dry-run', 'apply')

export const MigrationCommandInputSchema = Schema.Struct({
  adoOrg: Schema.optional(Schema.String),
  adoProject: Schema.optional(Schema.String),
  githubOrg: Schema.optional(Schema.String),
  apply: Schema.Boolean,
  output: Schema.optional(Schema.String),
  detail: Schema.String,
  prefix: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
  yes: Schema.Boolean,
  resume: Schema.optional(Schema.String),
  fresh: Schema.Boolean,
  foreground: Schema.Boolean,
  sessions: Schema.Boolean,
  concurrency: Schema.Number,
  teamTopology: Schema.optional(Schema.String),
  workerUrl: Schema.String,
  sandbox: Schema.optional(Schema.String),
  sandboxConfig: Schema.optional(Schema.String),
  listSandboxScenarios: Schema.Boolean,
  scenarioMode: Schema.optional(ScenarioModeSchema),
})

export type MigrationCommandInput = Schema.Schema.Type<typeof MigrationCommandInputSchema>

type MigrationFlag =
  | 'adoOrg'
  | 'adoProject'
  | 'githubOrg'
  | 'apply'
  | 'output'
  | 'detail'
  | 'prefix'
  | 'suffix'
  | 'yes'
  | 'resume'
  | 'fresh'
  | 'foreground'
  | 'sessions'
  | 'concurrency'
  | 'teamTopology'
  | 'workerUrl'
  | 'sandbox'
  | 'sandboxConfig'
  | 'listSandboxScenarios'

interface CommandCorrection {
  readonly remove?: ReadonlySet<MigrationFlag>
  readonly requireScope?: boolean
  readonly apply?: boolean
  readonly concurrency?: number
}

function stringFlag(
  arguments_: string[],
  input: MigrationCommandInput,
  correction: CommandCorrection,
  key: MigrationFlag,
  flag: string,
  value: string | undefined,
): void {
  if (!correction.remove?.has(key) && value) {
    arguments_.push(flag, value)
  }
}

export function renderMigrationCommandCorrection(
  input: MigrationCommandInput,
  correction: CommandCorrection = {},
): string {
  const arguments_ = ['ado-to-github-teams', 'migrate']
  const remove = correction.remove ?? new Set<MigrationFlag>()

  if (input.listSandboxScenarios && !remove.has('listSandboxScenarios')) {
    arguments_.push('--list-sandbox-scenarios')
    stringFlag(
      arguments_,
      input,
      correction,
      'sandboxConfig',
      '--sandbox-config',
      input.sandboxConfig,
    )
    return renderCliCommand(arguments_)
  }

  if (input.sandbox && !remove.has('sandbox')) {
    arguments_.push('--sandbox', input.sandbox)
    stringFlag(
      arguments_,
      input,
      correction,
      'sandboxConfig',
      '--sandbox-config',
      input.sandboxConfig,
    )
  } else {
    stringFlag(
      arguments_,
      input,
      correction,
      'adoOrg',
      '--ado-org',
      input.adoOrg ?? (correction.requireScope ? '<url>' : undefined),
    )
    stringFlag(
      arguments_,
      input,
      correction,
      'adoProject',
      '--ado-project',
      input.adoProject ?? (correction.requireScope ? '<project>' : undefined),
    )
    stringFlag(
      arguments_,
      input,
      correction,
      'githubOrg',
      '--github-org',
      input.githubOrg ?? (correction.requireScope ? '<org>' : undefined),
    )
  }

  const apply = correction.apply ?? input.apply
  if (apply && !remove.has('apply')) arguments_.push('--apply')
  stringFlag(arguments_, input, correction, 'output', '--output', input.output)
  if (input.detail !== 'guided' && !remove.has('detail')) arguments_.push('--detail', input.detail)
  stringFlag(arguments_, input, correction, 'prefix', '--prefix', input.prefix)
  stringFlag(arguments_, input, correction, 'suffix', '--suffix', input.suffix)
  if (input.yes && !remove.has('yes')) arguments_.push('--yes')
  stringFlag(arguments_, input, correction, 'resume', '--resume', input.resume)
  if (input.fresh && !remove.has('fresh')) arguments_.push('--fresh')
  if (input.foreground && !remove.has('foreground')) arguments_.push('--foreground')
  if (input.sessions && !remove.has('sessions')) arguments_.push('--sessions')
  const concurrency = correction.concurrency ?? input.concurrency
  if (concurrency !== 4 && !remove.has('concurrency')) {
    arguments_.push('--concurrency', String(concurrency))
  }
  stringFlag(arguments_, input, correction, 'teamTopology', '--team-topology', input.teamTopology)
  if (input.workerUrl !== 'http://127.0.0.1:7331' && !remove.has('workerUrl')) {
    arguments_.push('--worker-url', input.workerUrl)
  }
  return renderCliCommand(arguments_)
}

function failure(
  issue: MigrationCommandPreflightFailure['issue'],
  problem: string,
  input: MigrationCommandInput,
  correction: CommandCorrection,
) {
  const correctedCommand = renderMigrationCommandCorrection(input, correction)
  return Effect.fail(
    new MigrationCommandPreflightFailure({
      issue,
      message: `${problem}\nValid command: ${correctedCommand}`,
      correctedCommand,
    }),
  )
}

function validateDecodedMigrationCommand(input: MigrationCommandInput) {
  if (input.sandboxConfig && !input.sandbox && !input.listSandboxScenarios) {
    return failure(
      'sandbox-config-dependency',
      '--sandbox-config requires --sandbox or --list-sandbox-scenarios.',
      input,
      {remove: new Set(['sandboxConfig'])},
    )
  }
  if (input.teamTopology && input.prefix) {
    return failure(
      'topology-prefix-conflict',
      '--team-topology cannot be combined with --prefix; topology names are exact.',
      input,
      {remove: new Set(['prefix'])},
    )
  }
  if (input.teamTopology && input.suffix) {
    return failure(
      'topology-suffix-conflict',
      '--team-topology cannot be combined with --suffix; topology names are exact.',
      input,
      {remove: new Set(['suffix'])},
    )
  }
  if (input.fresh && input.resume) {
    return failure(
      'fresh-resume-conflict',
      '--fresh cannot be combined with --resume; resume preserves the retained checkpoint.',
      input,
      {remove: new Set(['fresh'])},
    )
  }
  if (input.yes && !input.sandbox) {
    return failure(
      'live-yes-conflict',
      '--yes is only available for sandbox scenarios with simulated provider writes.',
      input,
      {remove: new Set(['yes'])},
    )
  }
  if (input.sandbox && input.teamTopology) {
    return failure(
      'sandbox-topology-conflict',
      'Sandbox scenarios do not currently accept --team-topology.',
      input,
      {remove: new Set(['teamTopology'])},
    )
  }
  if (input.sandbox && input.resume) {
    return failure(
      'sandbox-resume-conflict',
      'Sandbox scenarios do not support --resume; start from fixture state.',
      input,
      {remove: new Set(['resume'])},
    )
  }
  if (input.scenarioMode === 'apply' && !input.apply) {
    return failure(
      'sandbox-apply-required',
      `Sandbox scenario "${input.sandbox}" requires --apply; provider writes remain simulated.`,
      input,
      {apply: true},
    )
  }
  if (input.scenarioMode === 'dry-run' && input.apply) {
    return failure(
      'sandbox-dry-run-apply-conflict',
      `Sandbox scenario "${input.sandbox}" is a dry-run scenario and does not accept --apply.`,
      input,
      {remove: new Set(['apply'])},
    )
  }
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
    return failure('invalid-concurrency', '--concurrency must be a positive integer.', input, {
      concurrency: 1,
    })
  }

  const hasAnyScope = Boolean(input.adoOrg || input.adoProject || input.githubOrg)
  const startsNewLiveRun = !input.sandbox && !input.listSandboxScenarios && !input.resume
  if (startsNewLiveRun && (input.fresh || hasAnyScope)) {
    const missingScope = [
      !input.adoOrg ? '--ado-org' : '',
      !input.adoProject ? '--ado-project' : '',
      !input.githubOrg ? '--github-org' : '',
    ].filter(Boolean)
    if (missingScope.length > 0) {
      return failure(
        'incomplete-live-scope',
        `Live migration requires a complete scope; missing ${missingScope.join(', ')}.`,
        input,
        {requireScope: true},
      )
    }
  }

  return Effect.succeed(input)
}

export interface MigrationCommandPreflightService {
  readonly validate: (
    input: unknown,
  ) => Effect.Effect<MigrationCommandInput, MigrationCommandPreflightFailure>
}

export class MigrationCommandPreflightTag extends Context.Tag('MigrationCommandPreflight')<
  MigrationCommandPreflightTag,
  MigrationCommandPreflightService
>() {}

export const MigrationCommandPreflightLiveLayer = Layer.succeed(MigrationCommandPreflightTag, {
  validate: (input) =>
    Schema.decodeUnknown(MigrationCommandInputSchema)(input).pipe(
      Effect.mapError(
        () =>
          new MigrationCommandPreflightFailure({
            issue: 'invalid-input',
            message: 'Migration command input is malformed.',
            correctedCommand: 'ado-to-github-teams migrate --help',
          }),
      ),
      Effect.flatMap(validateDecodedMigrationCommand),
    ),
})

export function validateMigrationCommand(input: unknown) {
  return Effect.gen(function* () {
    const preflight = yield* MigrationCommandPreflightTag
    return yield* preflight.validate(input)
  })
}
