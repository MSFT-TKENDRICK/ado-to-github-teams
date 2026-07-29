import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {Effect} from 'effect'
import {
  validateAdoCredential,
  validateEntraCredential,
  validateGitHubCredential,
} from '../auth/validate.js'
import {AuthLiveLayer} from '../effect/layers.js'
import {AuthServiceTag} from '../effect/services.js'
import {AuthManager} from '../auth/manager.js'

export default class Auth extends Command {
  static override description = 'Configure and validate Azure DevOps, GitHub, and Entra credentials'

  static override flags = {
    'ado-org': Flags.string({
      description: 'Azure DevOps organization URL used for credential validation',
      required: false,
    }),
    quiet: Flags.boolean({
      description: 'Suppress success output',
      default: false,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Auth)
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthServiceTag
        return yield* auth.resolveCredentials
      }).pipe(Effect.provide(AuthLiveLayer)),
    )

    if (flags['ado-org']) {
      await validateAdoCredential(credentials.ado, flags['ado-org'])
    } else {
      this.warn('Skipping ADO validation because --ado-org was not provided.')
    }

    await validateGitHubCredential(credentials.githubToken)
    await validateEntraCredential(credentials.entraCredential, credentials.entraScopes)

    if (!flags.quiet) {
      this.log(chalk.green('Credentials loaded and validated successfully.'))
      this.log(
        chalk.dim(
          `Azure DevOps: ${credentials.ado.source}; GitHub: ${credentials.githubSource}; Entra: ambient Azure identity`,
        ),
      )
      this.log(chalk.dim(`Non-secret config path: ${AuthManager.DEFAULT_CONFIG_PATH}`))
    }
  }
}
