import {createHash} from 'node:crypto'
import {readFile, stat} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {Effect, Either, ParseResult, Schema} from 'effect'
import {parse} from 'yaml'
import {
  AdoMemberSchema,
  AdoTeamSchema,
  EntraIdentitySchema,
  GitHubTeamSchema,
  GitHubUserSchema,
} from '../effect/schemas.js'
import {DecodeFailure, ValidationFailure} from '../effect/errors.js'
import {
  SandboxCatalogSchema,
  type SandboxCatalog,
  type SandboxInteraction,
  type SandboxOperation,
  type SandboxScenario,
} from './schema.js'

const maxConfigBytes = 1024 * 1024
const defaultCatalogUrl = new URL('../../sandbox/scenarios.yaml', import.meta.url)

type Validator = (
  input: unknown,
  message: string,
) => Effect.Effect<void, DecodeFailure>

function validator<A, I>(schema: Schema.Schema<A, I, never>): Validator {
  return (input, message) => decodeWith(schema, input, message).pipe(Effect.asVoid)
}

const operationValidators: Record<
  SandboxOperation,
  {readonly args: Validator; readonly value: Validator}
> = {
  'ado.getTeams': {
    args: validator(Schema.Struct({projectName: Schema.String})),
    value: validator(Schema.Array(AdoTeamSchema)),
  },
  'ado.getTeamMembers': {
    args: validator(Schema.Struct({projectId: Schema.String, teamId: Schema.String})),
    value: validator(Schema.Array(AdoMemberSchema)),
  },
  'ado.resolveGroupOriginId': {
    args: validator(Schema.Struct({descriptor: Schema.String})),
    value: validator(Schema.NullOr(Schema.String)),
  },
  'github.getTeamBySlug': {
    args: validator(Schema.Struct({slug: Schema.String})),
    value: validator(Schema.NullOr(GitHubTeamSchema)),
  },
  'github.createTeam': {
    args: validator(Schema.Struct({team: GitHubTeamSchema})),
    value: validator(GitHubTeamSchema),
  },
  'github.addTeamMember': {
    args: validator(Schema.Struct({teamSlug: Schema.String, username: Schema.String})),
    value: validator(Schema.Null),
  },
  'github.findUserByEmail': {
    args: validator(Schema.Struct({email: Schema.String})),
    value: validator(Schema.NullOr(GitHubUserSchema)),
  },
  'github.isUserSuspended': {
    args: validator(Schema.Struct({login: Schema.String})),
    value: validator(Schema.Boolean),
  },
  'entra.getGroupMembers': {
    args: validator(
      Schema.Struct({
        groupId: Schema.String,
        transitive: Schema.optional(Schema.Boolean),
      }),
    ),
    value: validator(Schema.Array(EntraIdentitySchema)),
  },
  'entra.resolveUserByUpn': {
    args: validator(Schema.Struct({upn: Schema.String})),
    value: validator(Schema.NullOr(EntraIdentitySchema)),
  },
}

export interface LoadedSandboxCatalog {
  readonly catalog: SandboxCatalog
  readonly path: string
  readonly digest: string
}

function decodeWith<A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
  message: string,
): Effect.Effect<A, DecodeFailure> {
  const decoded = Schema.decodeUnknownEither(schema, {onExcessProperty: 'error'})(input)
  if (Either.isLeft(decoded)) {
    return Effect.fail(
      new DecodeFailure({
        service: 'sandbox',
        message: `${message}\n${ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
        raw: input,
      }),
    )
  }
  return Effect.succeed(decoded.right)
}

function validateInteraction(
  interaction: SandboxInteraction,
): Effect.Effect<void, ValidationFailure | DecodeFailure> {
  return Effect.gen(function* () {
    if (!Number.isInteger(interaction.minCalls) || interaction.minCalls < 0) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Interaction ${interaction.id} has invalid minCalls`,
        }),
      )
    }
    if (
      !Number.isInteger(interaction.maxCalls) ||
      interaction.maxCalls < interaction.minCalls ||
      interaction.maxCalls < 1
    ) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Interaction ${interaction.id} has invalid maxCalls`,
        }),
      )
    }
    if (interaction.responses.length === 0) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Interaction ${interaction.id} must define at least one response`,
        }),
      )
    }
    if (!interaction.repeatLast && interaction.responses.length < interaction.maxCalls) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Interaction ${interaction.id} needs one response per allowed call or repeatLast: true`,
        }),
      )
    }
    if (interaction.responses.length > interaction.maxCalls) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Interaction ${interaction.id} has responses that can never be consumed`,
        }),
      )
    }

    const validators = operationValidators[interaction.operation]
    yield* validators.args(
      interaction.args,
      `Interaction ${interaction.id} has invalid arguments for ${interaction.operation}`,
    )
    for (const response of interaction.responses) {
      if ('value' in response) {
        yield* validators.value(
          response.value,
          `Interaction ${interaction.id} has an invalid response for ${interaction.operation}`,
        )
      }
    }
  })
}

function validateCatalog(
  catalog: SandboxCatalog,
): Effect.Effect<SandboxCatalog, ValidationFailure | DecodeFailure> {
  return Effect.gen(function* () {
    const scenarioIds = new Set<string>()
    for (const scenario of catalog.scenarios) {
      if (scenarioIds.has(scenario.id)) {
        return yield* Effect.fail(
          new ValidationFailure({
            service: 'sandbox',
            message: `Duplicate sandbox scenario id: ${scenario.id}`,
          }),
        )
      }
      scenarioIds.add(scenario.id)

      const fixtureIds = new Set<string>()
      const matchKeys = new Set<string>()
      for (const interaction of scenario.interactions) {
        if (fixtureIds.has(interaction.id)) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'sandbox',
              message: `Scenario ${scenario.id} has duplicate fixture id: ${interaction.id}`,
            }),
          )
        }
        fixtureIds.add(interaction.id)
        const matchKey = `${interaction.operation}:${JSON.stringify(interaction.args)}`
        if (matchKeys.has(matchKey)) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'sandbox',
              message: `Scenario ${scenario.id} has ambiguous interactions for ${interaction.operation}`,
            }),
          )
        }
        matchKeys.add(matchKey)
        yield* validateInteraction(interaction)
      }

      const approvalIds = new Set<string>()
      const approvalMatchers: string[] = []
      for (const approval of scenario.approvals) {
        if (approvalIds.has(approval.id)) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'sandbox',
              message: `Scenario ${scenario.id} has duplicate approval id: ${approval.id}`,
            }),
          )
        }
        approvalIds.add(approval.id)
        if (approval.actionIncludes.trim().length === 0) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'sandbox',
              message: `Scenario ${scenario.id} has an empty approval matcher`,
            }),
          )
        }
        if (
          approvalMatchers.some(
            (matcher) =>
              matcher.includes(approval.actionIncludes) ||
              approval.actionIncludes.includes(matcher),
          )
        ) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'sandbox',
              message: `Scenario ${scenario.id} has overlapping approval matchers`,
            }),
          )
        }
        approvalMatchers.push(approval.actionIncludes)
        if (
          !Number.isInteger(approval.minCalls) ||
          !Number.isInteger(approval.maxCalls) ||
          approval.minCalls < 0 ||
          approval.maxCalls < Math.max(1, approval.minCalls)
        ) {
          return yield* Effect.fail(
            new ValidationFailure({
              service: 'sandbox',
              message: `Scenario ${scenario.id} has invalid approval cardinality for ${approval.id}`,
            }),
          )
        }
      }
      if (scenario.expected.outcome === 'success') {
        for (const [operation, count] of Object.entries(
          scenario.expected.callCounts ?? {},
        )) {
          if (
            !operationValidators[operation as SandboxOperation] ||
            !Number.isInteger(count) ||
            count < 0
          ) {
            return yield* Effect.fail(
              new ValidationFailure({
                service: 'sandbox',
                message: `Scenario ${scenario.id} has an invalid expected call count`,
              }),
            )
          }
        }
      }
    }
    return catalog
  })
}

export function defaultSandboxCatalogPath(): string {
  return fileURLToPath(defaultCatalogUrl)
}

export function loadSandboxCatalog(
  configPath: string = defaultSandboxCatalogPath(),
): Effect.Effect<LoadedSandboxCatalog, DecodeFailure | ValidationFailure> {
  return Effect.gen(function* () {
    const fileStats = yield* Effect.tryPromise({
      try: async () => stat(configPath),
      catch: (error) =>
        new DecodeFailure({
          service: 'sandbox',
          message: `Unable to read sandbox config: ${configPath}`,
          raw: error,
        }),
    })
    if (fileStats.size > maxConfigBytes) {
      return yield* Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Sandbox config exceeds ${maxConfigBytes} bytes`,
        }),
      )
    }
    const text = yield* Effect.tryPromise({
      try: async () => readFile(configPath, 'utf8'),
      catch: (error) =>
        new DecodeFailure({
          service: 'sandbox',
          message: `Unable to read sandbox config: ${configPath}`,
          raw: error,
        }),
    })
    const raw = yield* Effect.try({
      try: () => parse(text, {maxAliasCount: 100, merge: true}) as unknown,
      catch: (error) =>
        new DecodeFailure({
          service: 'sandbox',
          message: `Invalid sandbox YAML: ${configPath}`,
          raw: error,
        }),
    })
    const decoded = yield* decodeWith(
      SandboxCatalogSchema,
      raw,
      `Malformed sandbox catalog: ${configPath}`,
    )
    const catalog = yield* validateCatalog(decoded)
    return {
      catalog,
      path: configPath,
      digest: createHash('sha256').update(text).digest('hex'),
    }
  })
}

export function findSandboxScenario(
  catalog: SandboxCatalog,
  scenarioId: string,
): Effect.Effect<SandboxScenario, ValidationFailure> {
  const scenario = catalog.scenarios.find((candidate) => candidate.id === scenarioId)
  return scenario
    ? Effect.succeed(scenario)
    : Effect.fail(
        new ValidationFailure({
          service: 'sandbox',
          message: `Unknown sandbox scenario "${scenarioId}". Use --list-sandbox-scenarios to list available scenarios.`,
        }),
      )
}
