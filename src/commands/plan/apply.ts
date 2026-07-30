import {Command, Flags} from '@oclif/core'
import {Effect} from 'effect'
import {loadMigrationPlanArtifact, loadMigrationPlanPatch, writeJsonFile} from '../../plans/io.js'
import {applyMigrationPlanPatch} from '../../plans/patch.js'

export default class PlanApply extends Command {
  static override description = 'Apply a hash-guarded patch to a migration plan artifact'

  static override flags = {
    base: Flags.string({description: 'Base migration plan artifact', required: true}),
    patch: Flags.string({description: 'Migration plan patch', required: true}),
    output: Flags.string({description: 'New patched plan artifact path', required: true}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(PlanApply)
    const output = await Effect.runPromise(
      Effect.all([loadMigrationPlanArtifact(flags.base), loadMigrationPlanPatch(flags.patch)], {
        concurrency: 2,
      }).pipe(
        Effect.flatMap(([base, patch]) => applyMigrationPlanPatch(base, patch)),
        Effect.flatMap((artifact) => writeJsonFile(flags.output, artifact)),
      ),
    )
    this.log(`Wrote patched migration plan to ${output}`)
  }
}
