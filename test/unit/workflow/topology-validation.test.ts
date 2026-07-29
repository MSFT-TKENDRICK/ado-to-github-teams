import {describe, expect, it} from 'vitest'
import {
  BackupTopologyError,
  validateBackupTopology,
} from '../../../src/workflow/topology-validation.js'

const PRODUCTION_OFF_HOST: NodeJS.ProcessEnv = {
  APP_ENV: 'production',
  WORKFLOW_NATS_URLS: 'nats://queue-primary:4222',
  LITESTREAM_NATS_URL: 'nats://backup-dr:4222',
  WORKFLOW_JETSTREAM_REPLICAS: '3',
  WORKFLOW_JETSTREAM_RETENTION: 'workqueue',
  WORKFLOW_JETSTREAM_MAX_MSGS: '100000',
}

function omit(env: NodeJS.ProcessEnv, key: keyof NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clone = {...env}
  delete clone[key]
  return clone
}

describe('validateBackupTopology', () => {
  it('does not enforce outside production and reports placement', () => {
    const topology = validateBackupTopology({
      APP_ENV: 'development',
      WORKFLOW_NATS_URLS: 'nats://nats:4222',
      LITESTREAM_NATS_URL: 'nats://nats:4222',
    })
    expect(topology.enforced).toBe(false)
    expect(topology.placement).toBe('co-located')
  })

  it('accepts an off-host production backup without acknowledgement', () => {
    const topology = validateBackupTopology(PRODUCTION_OFF_HOST)
    expect(topology.enforced).toBe(true)
    expect(topology.placement).toBe('off-host')
    expect(topology.jetStream).toEqual({
      replicas: 3,
      retention: 'workqueue',
      maxMessages: 100000,
    })
  })

  it('rejects a co-located single-node backup in production without acknowledgement', () => {
    expect(() =>
      validateBackupTopology({
        ...PRODUCTION_OFF_HOST,
        LITESTREAM_NATS_URL: 'nats://queue-primary:4222',
      }),
    ).toThrow(BackupTopologyError)
  })

  it('allows a co-located backup when explicitly acknowledged and notes the reduced durability', () => {
    const topology = validateBackupTopology({
      ...PRODUCTION_OFF_HOST,
      LITESTREAM_NATS_URL: 'nats://queue-primary:4222',
      WORKFLOW_ALLOW_COLOCATED_BACKUP: 'true',
    })
    expect(topology.placement).toBe('co-located')
    expect(topology.colocatedAcknowledged).toBe(true)
    expect(topology.notes.join(' ')).toMatch(/demo-grade/i)
  })

  it('requires an explicit JetStream replica declaration in production', () => {
    const rest = omit(PRODUCTION_OFF_HOST, 'WORKFLOW_JETSTREAM_REPLICAS')
    expect(() => validateBackupTopology(rest)).toThrow(/WORKFLOW_JETSTREAM_REPLICAS/)
  })

  it('requires an explicit overflow bound in production', () => {
    const rest = omit(PRODUCTION_OFF_HOST, 'WORKFLOW_JETSTREAM_MAX_MSGS')
    expect(() => validateBackupTopology(rest)).toThrow(/WORKFLOW_JETSTREAM_MAX_MSGS/)
  })

  it('rejects a retention mode incompatible with the queue world', () => {
    expect(() =>
      validateBackupTopology({
        ...PRODUCTION_OFF_HOST,
        WORKFLOW_JETSTREAM_RETENTION: 'limits',
      }),
    ).toThrow(/workqueue/)
  })

  it('notes single-replica exposure even when the backup is off-host', () => {
    const topology = validateBackupTopology({
      ...PRODUCTION_OFF_HOST,
      WORKFLOW_JETSTREAM_REPLICAS: '1',
    })
    expect(topology.jetStream.replicas).toBe(1)
    expect(topology.notes.join(' ')).toMatch(/not highly available/i)
  })
})
