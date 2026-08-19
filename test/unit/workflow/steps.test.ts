import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'
import {
  applyMigrationStep,
  generateEscalationReportStep,
  prepareMigrationStep,
} from '../../../src/workflow/steps.js'
import type {MigrationWorkflowInput} from '../../../src/workflow/contracts.js'

interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string
  readonly body: string
}

interface StepServer {
  readonly url: string
  readonly requests: () => readonly CapturedRequest[]
  readonly close: () => Promise<void>
}

type Responder = (request: CapturedRequest) => {status: number; body: string}

/**
 * A real loopback HTTP peer for the migration worker. `steps.ts` calls the
 * worker with `fetch`, so a genuine socket is the honest way to drive its
 * request shaping, header/authorization handling and response decoding without
 * stubbing `fetch`.
 */
async function startStepServer(responder: Responder): Promise<StepServer> {
  const captured: CapturedRequest[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const entry: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      }
      captured.push(entry)
      const {status, body} = responder(entry)
      response.writeHead(status, {'content-type': 'application/json'})
      response.end(body)
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => [...captured],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function input(
  workerBaseUrl: string,
  overrides: Partial<MigrationWorkflowInput> = {},
): MigrationWorkflowInput {
  return {
    runId: 'run-1',
    adoOrg: 'https://dev.azure.com/contoso',
    adoProject: 'Platform',
    githubOrg: 'contoso',
    apply: false,
    concurrency: 4,
    workerBaseUrl,
    taskTokens: {
      prepare: 'prepare-token',
      apply: 'apply-token',
      escalation: 'escalation-token',
    },
    ...overrides,
  }
}

let server: StepServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('migration workflow steps', () => {
  it('posts the prepare task with its bearer token and returns the decoded result', async () => {
    server = await startStepServer(() => ({
      status: 200,
      body: JSON.stringify({runId: 'run-1', reportPath: 'reports/run-1.md', status: 'completed'}),
    }))

    const result = await prepareMigrationStep(input(server.url), 'wf-1')

    expect(result).toEqual({runId: 'run-1', reportPath: 'reports/run-1.md', status: 'completed'})
    const [request] = server.requests()
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe('/internal/migrations/run-1/prepare')
    expect(request?.authorization).toBe('Bearer prepare-token')
    const sent: unknown = JSON.parse(request?.body ?? '{}')
    expect(sent).toMatchObject({runId: 'run-1', workflowRunId: 'wf-1', apply: false})
  })

  it('posts the apply task against the apply endpoint with the apply token', async () => {
    server = await startStepServer(() => ({
      status: 200,
      body: JSON.stringify({runId: 'run-1', reportPath: 'reports/run-1.md', status: 'in-progress'}),
    }))

    const result = await applyMigrationStep(input(server.url, {apply: true}), 'wf-9')

    expect(result).toEqual({runId: 'run-1', reportPath: 'reports/run-1.md', status: 'in-progress'})
    const [request] = server.requests()
    expect(request?.url).toBe('/internal/migrations/run-1/apply')
    expect(request?.authorization).toBe('Bearer apply-token')
  })

  it('percent-encodes the run id in the task path', async () => {
    server = await startStepServer(() => ({
      status: 200,
      body: JSON.stringify({runId: 'org/run 1', reportPath: 'reports/x.md', status: 'completed'}),
    }))

    await prepareMigrationStep(input(server.url, {runId: 'org/run 1'}), 'wf-1')

    expect(server.requests()[0]?.url).toBe('/internal/migrations/org%2Frun%201/prepare')
  })

  it('raises a bounded error when the worker returns a non-2xx status', async () => {
    server = await startStepServer(() => ({status: 500, body: 'internal boom'}))

    await expect(prepareMigrationStep(input(server.url), 'wf-1')).rejects.toThrow(
      /Migration worker prepare failed with HTTP 500: internal boom/,
    )
  })

  it('rejects a worker payload that does not decode to a migration task result', async () => {
    server = await startStepServer(() => ({
      status: 200,
      body: JSON.stringify({runId: 'run-1', reportPath: 'reports/run-1.md', status: 'bogus'}),
    }))

    await expect(applyMigrationStep(input(server.url, {apply: true}), 'wf-1')).rejects.toThrow(
      'Invalid migration task result',
    )
  })

  it('posts the escalation report with its token, workflow run id and elicitation id', async () => {
    server = await startStepServer(() => ({
      status: 200,
      body: JSON.stringify({runId: 'run-1', reportPath: 'reports/esc.md', status: 'completed'}),
    }))

    const result = await generateEscalationReportStep(input(server.url), 'wf-2', 'elicit-77')

    expect(result).toEqual({runId: 'run-1', reportPath: 'reports/esc.md', status: 'completed'})
    const [request] = server.requests()
    expect(request?.url).toBe('/internal/migrations/run-1/escalation')
    expect(request?.authorization).toBe('Bearer escalation-token')
    const sent: unknown = JSON.parse(request?.body ?? '{}')
    expect(sent).toMatchObject({workflowRunId: 'wf-2', elicitationId: 'elicit-77'})
  })

  it('raises a bounded error when the escalation endpoint fails', async () => {
    server = await startStepServer(() => ({status: 503, body: 'unavailable'}))

    await expect(
      generateEscalationReportStep(input(server.url), 'wf-2', 'elicit-77'),
    ).rejects.toThrow(/escalation report failed with HTTP 503/)
  })
})
