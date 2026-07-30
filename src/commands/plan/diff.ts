import {Command, Flags} from '@oclif/core'
import {Effect} from 'effect'
import {loadMigrationPlanArtifact, writeJsonFile} from '../../plans/io.js'
import {diffMigrationPlans} from '../../plans/patch.js'

export default class PlanDiff extends Command {
  static override description = 'Create a hash-guarded patch between compatible migration plans'

  static override flags = {
    base: Flags.string({description: 'Base migration plan artifact', required: true}),
    alternative: Flags.string({description: 'Alternative migration plan artifact', required: true}),
    output: Flags.string({description: 'New JSON patch path', required: true}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(PlanDiff)
    const output = await Effect.runPromise(
      Effect.all(
        [loadMigrationPlanArtifact(flags.base), loadMigrationPlanArtifact(flags.alternative)],
        {concurrency: 2},
      ).pipe(
        Effect.flatMap(([base, alternative]) => diffMigrationPlans(base, alternative)),
        Effect.flatMap((patch) => writeJsonFile(flags.output, patch)),
      ),
    )
    this.log(`Wrote migration plan patch to ${output}`)
  }
}
