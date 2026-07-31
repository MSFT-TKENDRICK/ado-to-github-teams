import {readFile} from 'node:fs/promises'
import path from 'node:path'

export async function assertWorkflowBundle(
  bundleDirectory = path.resolve('.workflow-data', 'build', 'workflow'),
) {
  const [manifestText, workflowsBundle, stepsBundle] = await Promise.all([
    readFile(path.join(bundleDirectory, 'manifest.json'), 'utf8'),
    readFile(path.join(bundleDirectory, 'workflows.mjs'), 'utf8'),
    readFile(path.join(bundleDirectory, 'steps.mjs'), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  const workflows = Object.keys(manifest.workflows ?? {})
  const steps = Object.keys(manifest.steps ?? {})

  if (workflows.length === 0 || steps.length === 0) {
    throw new Error(
      'Workflow compilation produced an empty registry. Azure packaging is blocked because queue delivery would be unable to resolve workflows or steps.',
    )
  }
  if (
    !workflowsBundle.includes('__private_workflows') ||
    !stepsBundle.includes('WORKFLOW_USE_STEP')
  ) {
    throw new Error(
      'Workflow bundles are missing their generated registrations. Azure packaging is blocked.',
    )
  }

  return {workflows: workflows.length, steps: steps.length}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = await assertWorkflowBundle()
  console.log(
    `Validated Workflow bundle: ${result.workflows} workflow(s), ${result.steps} step(s).`,
  )
}
