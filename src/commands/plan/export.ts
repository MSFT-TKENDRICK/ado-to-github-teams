import {Command, Flags} from '@oclif/core'
import {Effect} from 'effect'
import {CheckpointManager} from '../../checkpoints/manager.js'
import {exportMigrationPlan} from '../../plans/artifact.js'
import {writeJsonFile} from '../../plans/io.js'
import {makeWorkflowWorkerLayer, WorkflowWorkerServiceTag} from '../../workflow/client.js'

export default class PlanExport extends Command {
  static override description =
    'Export a planned checkpoint as a portable, mergeable migration plan'

  static override flags = {
    'run-id': Flags.string({
      description: 'Migration checkpoint run ID',
      required: true,
    }),
    'checkpoint-db': Flags.string({
      description: 'Read from a local workflow database instead of the worker API',
      required: false,
    }),
    'worker-url': Flags.string({
      description: 'Durable migration worker URL',
      default: process.env.WORKFLOW_BASE_URL ?? 'http://127.0.0.1:7331',
    }),
    output: Flags.string({
      description: 'New JSON plan artifact path',
      required: true,
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(PlanExport)
    if (flags['checkpoint-db']) {
      const checkpoint = await new CheckpointManager(flags['checkpoint-db']).load(flags['run-id'])
      if (!checkpoint) {
        this.error(`Checkpoint ${flags['run-id']} was not found.`)
      }
      const output = await Effect.runPromise(
        exportMigrationPlan(checkpoint).pipe(
          Effect.flatMap((artifact) => writeJsonFile(flags.output, artifact)),
        ),
      )
      this.log(`Exported migration plan ${checkpoint.runId} to ${output}`)
      return
    }
    const apiToken = process.env.WORKFLOW_API_TOKEN
    if (!apiToken || apiToken.length < 32) {
      this.error('WORKFLOW_API_TOKEN must contain at least 32 characters.')
    }
    const workerLayer = makeWorkflowWorkerLayer(flags['worker-url'], apiToken)
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* WorkflowWorkerServiceTag
        return yield* worker.planArtifact(flags['run-id'])
      }).pipe(
        Effect.provide(workerLayer),
        Effect.flatMap((artifact) => writeJsonFile(flags.output, artifact)),
      ),
    )
    this.log(`Exported migration plan ${flags['run-id']} to ${output}`)
  }
}
