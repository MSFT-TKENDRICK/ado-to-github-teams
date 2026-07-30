import {Command, Flags} from '@oclif/core'
import {Effect} from 'effect'
import {
  loadMigrationPlanArtifact,
  loadMigrationPlanConflictDocument,
  writeJsonFile,
} from '../../plans/io.js'
import {mergeMigrationPlans} from '../../plans/merge.js'

export default class PlanMerge extends Command {
  static override description =
    'Three-way merge compatible migration plans and surface semantic conflicts'

  static override flags = {
    base: Flags.string({description: 'Common base migration plan artifact', required: true}),
    left: Flags.string({description: 'First alternative migration plan artifact', required: true}),
    right: Flags.string({
      description: 'Second alternative migration plan artifact',
      required: true,
    }),
    output: Flags.string({description: 'New merged migration plan path', required: true}),
    conflicts: Flags.string({
      description: 'New JSON conflict document path when automatic merge is incomplete',
      required: true,
    }),
    resolutions: Flags.string({
      description: 'Edited conflict document with explicit left/right resolutions',
      required: false,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(PlanMerge)
    const inputs = await Effect.runPromise(
      Effect.all(
        {
          base: loadMigrationPlanArtifact(flags.base),
          left: loadMigrationPlanArtifact(flags.left),
          right: loadMigrationPlanArtifact(flags.right),
          resolutions: flags.resolutions
            ? loadMigrationPlanConflictDocument(flags.resolutions).pipe(
                Effect.map((value) => value),
              )
            : Effect.succeed(undefined),
        },
        {concurrency: 4},
      ),
    )
    const result = await Effect.runPromise(
      mergeMigrationPlans(inputs.base, inputs.left, inputs.right, inputs.resolutions),
    )
    if (result._tag === 'Conflicted') {
      if (flags.resolutions) {
        this.error('The supplied conflict document does not resolve every current conflict.')
      }
      const conflictPath = await Effect.runPromise(writeJsonFile(flags.conflicts, result.document))
      this.log(`Merge requires explicit resolution; wrote ${conflictPath}`)
      this.exit(2)
    }
    const output = await Effect.runPromise(writeJsonFile(flags.output, result.artifact))
    this.log(`Wrote merged migration plan to ${output}`)
  }
}
