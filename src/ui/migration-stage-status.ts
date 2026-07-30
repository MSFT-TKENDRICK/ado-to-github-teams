import type {CheckpointState} from '../types/index.js'
import {DEFAULT_PRESENTATION_MODE, type PresentationMode} from './adaptive-detail.js'

type MigrationPhase = CheckpointState['phase']

export interface MigrationStageDefinition {
  readonly phase: MigrationPhase
  readonly label: string
  readonly nextEvent: string
}

export const MIGRATION_STAGES: readonly MigrationStageDefinition[] = [
  {
    phase: 'fetch',
    label: 'Discovering source teams',
    nextEvent: 'Identity matching begins after source discovery.',
  },
  {
    phase: 'map',
    label: 'Matching people and teams',
    nextEvent: 'The proposed migration plan will be prepared for review.',
  },
  {
    phase: 'dry-run',
    label: 'Reviewing the proposed migration',
    nextEvent: 'Review the exact plan, then approve target writes or keep the dry-run result.',
  },
  {
    phase: 'create-teams',
    label: 'Creating GitHub teams',
    nextEvent: 'Member assignments begin after the required teams exist.',
  },
  {
    phase: 'assign-members',
    label: 'Assigning team members',
    nextEvent: 'Repository permissions are applied after membership assignments.',
  },
  {
    phase: 'grant-repositories',
    label: 'Applying repository permissions',
    nextEvent: 'A durable migration report is generated after permissions are applied.',
  },
  {
    phase: 'report',
    label: 'Generating the migration report',
    nextEvent: 'Review the report and resolve any skipped items or edge cases.',
  },
]

const STAGES = Object.fromEntries(MIGRATION_STAGES.map((stage) => [stage.phase, stage])) as Record<
  MigrationPhase,
  MigrationStageDefinition
>

export interface MigrationStageStatus {
  readonly runId: string
  readonly state: string
  readonly currentStage: string
  readonly nextEvent: string
  readonly lastUpdated: string
}

export interface MigrationStageStatusInput {
  readonly runId: string
  readonly phase: string
  readonly workflowStatus: string
  readonly updatedAt?: string | undefined
  readonly blockingCount?: number | undefined
}

function sentenceCase(value: string): string {
  const normalized = value.trim().replaceAll(/[-_]+/g, ' ')
  return normalized.length > 0
    ? `${normalized[0]?.toUpperCase() ?? ''}${normalized.slice(1)}`
    : 'Unknown'
}

export function migrationStageStatus(input: MigrationStageStatusInput): MigrationStageStatus {
  const phase = STAGES[input.phase as MigrationPhase]
  const workflowStatus = input.workflowStatus.toLowerCase()
  const blockingCount = input.blockingCount ?? 0

  if (blockingCount > 0 || workflowStatus === 'blocked') {
    return {
      runId: input.runId,
      state: `Blocked (${blockingCount || 1} decision${blockingCount === 1 ? '' : 's'} needed)`,
      currentStage: phase?.label ?? `Unrecognized worker stage (${input.phase})`,
      nextEvent: 'Resolve the blocking decision in the session inbox to continue.',
      lastUpdated: input.updatedAt ?? 'Pending first worker update',
    }
  }

  if (workflowStatus === 'completed') {
    return {
      runId: input.runId,
      state: 'Completed',
      currentStage: 'Migration workflow complete',
      nextEvent: 'Review the durable migration report and resolve any remaining edge cases.',
      lastUpdated: input.updatedAt ?? 'Pending final worker update',
    }
  }

  if (workflowStatus === 'failed' || workflowStatus === 'cancelled') {
    return {
      runId: input.runId,
      state: sentenceCase(workflowStatus),
      currentStage: phase?.label ?? `Unrecognized worker stage (${input.phase})`,
      nextEvent: 'Review the worker failure and resume from the last durable checkpoint.',
      lastUpdated: input.updatedAt ?? 'No worker update recorded',
    }
  }

  return {
    runId: input.runId,
    state: sentenceCase(input.workflowStatus),
    currentStage: phase?.label ?? `Unrecognized worker stage (${input.phase})`,
    nextEvent:
      phase?.nextEvent ??
      'Refresh the session and inspect the worker before taking further action.',
    lastUpdated: input.updatedAt ?? 'Pending first worker update',
  }
}

export function renderMigrationStageStatus(
  input: MigrationStageStatusInput,
  presentationMode: PresentationMode = DEFAULT_PRESENTATION_MODE,
): readonly string[] {
  const status = migrationStageStatus(input)
  if (presentationMode === 'compact') {
    return [
      `[${status.state}] ${status.runId} · ${status.currentStage} · Next: ${status.nextEvent} · Updated: ${status.lastUpdated}`,
    ]
  }
  return [
    `Run ID: ${status.runId}`,
    `Status: ${status.state}`,
    `Current stage: ${status.currentStage}`,
    `Next event: ${status.nextEvent}`,
    `Last update: ${status.lastUpdated}`,
  ]
}
