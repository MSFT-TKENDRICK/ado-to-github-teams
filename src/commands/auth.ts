import {Command, Flags} from '@oclif/core'
import {Effect, Either} from 'effect'
import {
  credentialResolutionDiagnostics,
  renderAuthDiagnostics,
  renderAuthDiagnosticsJson,
  runAuthDiagnostics,
} from '../auth/diagnostics.js'
import {AuthLiveLayer, AuthValidationLiveLayer, makeAuthLayer} from '../effect/layers.js'
import {AuthServiceTag} from '../effect/services.js'

export default class Auth extends Command {
  static override description =
    'Diagnose Azure DevOps, GitHub, and Entra credentials without exposing secrets'

  static override examples = [
    {
      description: 'Validate all three providers, including Azure DevOps organization access',
      command: '<%= config.bin %> <%= command.id %> --ado-org https://dev.azure.com/contoso',
    },
    {
      description: 'Emit a stable non-secret diagnostic document for CI',
      command: '<%= config.bin %> <%= command.id %> --ado-org https://dev.azure.com/contoso --json',
    },
    {
      description: 'Use exit status only; Azure DevOps is skipped when --ado-org is omitted',
      command: '<%= config.bin %> <%= command.id %> --quiet',
    },
  ]

  static override flags = {
    'ado-org': Flags.string({
      aliases: ['source-org'],
      description:
        'Azure DevOps organization URL; required to validate ADO access (for example, https://dev.azure.com/contoso)',
      helpGroup: 'SCOPE',
      required: false,
    }),
    json: Flags.boolean({
      description:
        'Disable interactive fallback and emit schema version 1 diagnostics as deterministic JSON',
      default: false,
      exclusive: ['quiet'],
      helpGroup: 'OUTPUT',
    }),
    quiet: Flags.boolean({
      description: 'Suppress successful diagnostics; failures still print',
      default: false,
      exclusive: ['json'],
      helpGroup: 'OUTPUT',
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Auth)
    const authLayer = flags.json ? makeAuthLayer({interactive: false}) : AuthLiveLayer
    const credentialResolution = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const auth = yield* AuthServiceTag
          return yield* auth.resolveCredentials
        }).pipe(Effect.provide(authLayer)),
      ),
    )
    const diagnostics = Either.isLeft(credentialResolution)
      ? await Effect.runPromise(
          credentialResolutionDiagnostics(credentialResolution.left, flags['ado-org']),
        )
      : await Effect.runPromise(
          runAuthDiagnostics(credentialResolution.right, flags['ado-org']).pipe(
            Effect.provide(AuthValidationLiveLayer),
          ),
        )

    if (flags.json) {
      this.log(renderAuthDiagnosticsJson(diagnostics))
    } else if (!flags.quiet || diagnostics.status === 'failed') {
      this.log(renderAuthDiagnostics(diagnostics))
    }
    if (diagnostics.status === 'failed') {
      this.exit(1)
    }
  }
}
