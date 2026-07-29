import {describe, expect, it} from 'vitest'
import {describeEntraActor} from '../../../src/workflow/actor.js'

describe('Entra actor description', () => {
  it('identifies workload identities without persisting credentials', () => {
    const actor = describeEntraActor({
      AZURE_FEDERATED_TOKEN_FILE: 'C:\\tokens\\federated',
      AZURE_CLIENT_ID: 'client-1',
      AZURE_TENANT_ID: 'tenant-1',
      USERNAME: 'migration-runner',
      AZURE_CLIENT_SECRET: 'must-not-be-captured',
    })

    expect(actor).toEqual({
      kind: 'workload-identity',
      displayName: 'migration-runner',
      tenantId: 'tenant-1',
      clientId: 'client-1',
    })
    expect(JSON.stringify(actor)).not.toContain('must-not-be-captured')
  })
})
