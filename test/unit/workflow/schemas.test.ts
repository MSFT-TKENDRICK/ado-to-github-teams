import {describe, expect, it} from 'vitest'
import {decodeMigrationWorkflowInput} from '../../../src/workflow/schemas.js'

const baseInput = {
  runId: '11111111-1111-4111-8111-111111111111',
  adoOrg: 'https://dev.azure.com/contoso',
  adoProject: 'Platform',
  githubOrg: 'contoso',
  apply: true,
  concurrency: 4,
  workerBaseUrl: 'http://127.0.0.1:7331',
  taskToken: 'task-token',
}

describe('migration workflow input schema', () => {
  it('preserves a validated topology across the durable boundary', () => {
    const topology = {
      config: {
        version: 1 as const,
        organizationalUnit: {name: 'Engineering'},
        repositories: [
          {
            repository: 'contoso/api',
            teamName: 'API Contributors',
            sourceAdoTeams: ['API'],
            role: 'write' as const,
          },
        ],
      },
      digest: 'topology-digest',
    }

    expect(decodeMigrationWorkflowInput({...baseInput, topology}).topology).toEqual(topology)
  })

  it('rejects an unapproved admin grant at the worker boundary', () => {
    expect(() =>
      decodeMigrationWorkflowInput({
        ...baseInput,
        topology: {
          config: {
            version: 1,
            organizationalUnit: {name: 'Engineering'},
            repositories: [
              {
                repository: 'contoso/api',
                teamName: 'API Admins',
                sourceAdoTeams: ['API'],
                role: 'admin',
              },
            ],
          },
          digest: 'topology-digest',
        },
      }),
    ).toThrow('allowAdmin is not true')
  })
})
