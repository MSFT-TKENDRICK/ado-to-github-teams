export function assertWorkflowBundle(
  bundleDirectory?: string,
): Promise<{readonly workflows: number; readonly steps: number}>
