/**
 * Production backup-topology and JetStream posture validation.
 *
 * The composed local World backs SQLite up with Litestream and runs the live
 * queue on NATS JetStream. Litestream is asynchronous disaster recovery
 * (RPO > 0), not high availability: if the backup target is the same NATS node
 * that also carries the live queue, a single host loss takes the queue and its
 * only backup together, so the backup cannot actually recover the lost work.
 *
 * In production this module rejects that co-located single-node topology unless
 * it is explicitly acknowledged, and requires the JetStream retention, replica,
 * and overflow posture to be declared rather than silently inheriting the queue
 * world's defaults (single replica, workqueue retention, discard-old overflow).
 */

export type BackupPlacement = 'off-host' | 'co-located' | 'indeterminate'

export interface BackupTopology {
  readonly enforced: boolean
  readonly placement: BackupPlacement
  readonly colocatedAcknowledged: boolean
  readonly liveQueueHosts: readonly string[]
  readonly backupHost: string | undefined
  readonly jetStream: {
    readonly replicas: number
    readonly retention: string
    readonly maxMessages: number
  }
  /** Human-readable posture notes for operator logs. */
  readonly notes: readonly string[]
}

export class BackupTopologyError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'BackupTopologyError'
  }
}

/** Retention mode the NATS JetStream queue world actually creates streams with. */
const REQUIRED_RETENTION = 'workqueue'

function hostOf(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) {
    return undefined
  }
  const withScheme = trimmed.includes('://') ? trimmed : `nats://${trimmed}`
  try {
    const host = new URL(withScheme).hostname.toLowerCase()
    return host.length > 0 ? host : undefined
  } catch {
    return undefined
  }
}

function splitHosts(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }
  return raw
    .split(',')
    .map((entry) => hostOf(entry))
    .filter((host): host is string => host !== undefined)
}

function requirePositiveInt(environment: NodeJS.ProcessEnv, name: string): number {
  const raw = environment[name]?.trim()
  if (!raw) {
    throw new BackupTopologyError(
      `Production requires ${name} to be declared explicitly rather than inheriting the queue world default.`,
    )
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BackupTopologyError(`${name} must be a positive integer, received "${raw}".`)
  }
  return parsed
}

function isProduction(environment: NodeJS.ProcessEnv): boolean {
  return environment.APP_ENV?.trim() === 'production'
}

/**
 * Validates the backup topology and JetStream posture. Throws
 * {@link BackupTopologyError} in production for a co-located single-node backup
 * that is not explicitly acknowledged, or for an undeclared / incompatible
 * JetStream posture. Outside production it never throws and reports the observed
 * placement for logging.
 */
export function validateBackupTopology(
  environment: NodeJS.ProcessEnv = process.env,
): BackupTopology {
  const liveQueueHosts = splitHosts(environment.WORKFLOW_NATS_URLS)
  const backupHost = hostOf(environment.LITESTREAM_NATS_URL ?? '')
  const colocatedAcknowledged = environment.WORKFLOW_ALLOW_COLOCATED_BACKUP?.trim() === 'true'
  const enforced = isProduction(environment)

  let placement: BackupPlacement = 'indeterminate'
  if (backupHost !== undefined && liveQueueHosts.length > 0) {
    placement = liveQueueHosts.includes(backupHost) ? 'co-located' : 'off-host'
  }

  const notes: string[] = [
    'Litestream is asynchronous disaster recovery (RPO > 0), not high availability.',
  ]

  if (!enforced) {
    return {
      enforced,
      placement,
      colocatedAcknowledged,
      liveQueueHosts,
      backupHost,
      jetStream: {
        replicas: Number.parseInt(environment.WORKFLOW_JETSTREAM_REPLICAS ?? '1', 10),
        retention: (environment.WORKFLOW_JETSTREAM_RETENTION ?? REQUIRED_RETENTION).toLowerCase(),
        maxMessages: Number.parseInt(environment.WORKFLOW_JETSTREAM_MAX_MSGS ?? '100000', 10),
      },
      notes,
    }
  }

  if (placement === 'co-located' && !colocatedAcknowledged) {
    throw new BackupTopologyError(
      `Litestream backup target ${String(backupHost)} is co-located on a live queue host ` +
        `(${liveQueueHosts.join(', ')}). A single-node co-located backup is not failure-independent: ` +
        'set an off-host LITESTREAM_NATS_URL, or, for a demo, acknowledge the reduced durability with ' +
        'WORKFLOW_ALLOW_COLOCATED_BACKUP=true.',
    )
  }

  const replicas = requirePositiveInt(environment, 'WORKFLOW_JETSTREAM_REPLICAS')
  const retention = (environment.WORKFLOW_JETSTREAM_RETENTION?.trim() ?? '').toLowerCase()
  if (!retention) {
    throw new BackupTopologyError(
      'Production requires WORKFLOW_JETSTREAM_RETENTION to be declared explicitly.',
    )
  }
  if (retention !== REQUIRED_RETENTION) {
    throw new BackupTopologyError(
      `WORKFLOW_JETSTREAM_RETENTION must be "${REQUIRED_RETENTION}" to match the queue world's streams, received "${retention}".`,
    )
  }
  const maxMessages = requirePositiveInt(environment, 'WORKFLOW_JETSTREAM_MAX_MSGS')

  if (placement === 'co-located' && colocatedAcknowledged) {
    notes.push(
      'Co-located single-node backup explicitly acknowledged; durability is demo-grade, not production DR.',
    )
  }
  if (replicas <= 1) {
    notes.push(
      'JetStream configured with a single replica; the queue is not highly available across host loss.',
    )
  }

  return {
    enforced,
    placement,
    colocatedAcknowledged,
    liveQueueHosts,
    backupHost,
    jetStream: {replicas, retention, maxMessages},
    notes,
  }
}
