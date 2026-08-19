import http from 'node:http'
import type {AddressInfo, Socket} from 'node:net'

/**
 * A deterministic transport-fault server.
 *
 * Purpose: `src/effect/classify.ts` decides whether a failure is retryable partly by inspecting
 * `error.code` for `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ECONNREFUSED` and `ENOTFOUND`. Those
 * codes are produced by the *socket*, not by the application — no Effect test Layer, and no Pact
 * mock server, can generate them. A fault-injection Layer proves the orchestrator reacts correctly
 * to a failure *value*; it cannot prove the HTTP client actually produces that value when a real
 * peer misbehaves. This server closes that gap by making a real socket misbehave underneath the
 * real client.
 *
 * It is deliberately scripted rather than random. Randomised chaos in a required suite produces
 * non-reproducible red builds and gets disabled; a fixed fault sequence is reproducible, debuggable,
 * and still exercises the code path that matters.
 *
 * This is intentionally NOT expressed as Pact interactions. For the two internally-verified
 * bi-directional contracts a synthetic failure interaction would become a provider obligation and
 * force the provider to reproduce a fault on demand. Response *shapes* here are contract-derived;
 * the faults are not part of any contract.
 */
export type TransportFault =
  /** A normal, well-formed JSON response. */
  | {readonly kind: 'ok'; readonly status: number; readonly body: unknown}
  /** Destroy the socket before writing any response — the classic connection reset. */
  | {readonly kind: 'reset-before-headers'}
  /** Write headers and a partial body, then destroy the socket mid-stream. */
  | {readonly kind: 'reset-mid-body'; readonly status: number; readonly partialBody: string}
  /** Promise more bytes in `Content-Length` than are actually sent, then end the stream. */
  | {readonly kind: 'truncated-body'; readonly status: number; readonly partialBody: string}
  /** Accept the request and never answer. The caller is expected to impose its own deadline. */
  | {readonly kind: 'hang'}
  /** A throttling response carrying a `Retry-After` header. */
  | {readonly kind: 'throttled'; readonly status: number; readonly retryAfterSeconds: number}

export interface FaultServer {
  /** Base URL to hand to an adapter factory, e.g. `makeGitHubLayer(creds, org, server.url)`. */
  readonly url: string
  /** How many requests the client actually issued — the retry-budget observation point. */
  readonly requestCount: () => number
  /** Paths of the requests received, in order. */
  readonly requestPaths: () => ReadonlyArray<string>
  readonly close: () => Promise<void>
}

/**
 * Starts a fault server driven by `script`.
 *
 * Faults are consumed in order, one per request. Once the script is exhausted the final entry
 * repeats, so a client that retries more times than the script is long still meets a defined peer
 * instead of an accidental connection error.
 */
export async function startFaultServer(
  script: ReadonlyArray<TransportFault>,
): Promise<FaultServer> {
  if (script.length === 0) {
    throw new Error('startFaultServer requires at least one fault in the script')
  }

  let received = 0
  const paths: string[] = []
  // Tracked so `close()` can tear down sockets parked by a `hang` fault. Without this the server
  // never emits `close` and the test file hangs instead of failing.
  const openSockets = new Set<Socket>()

  const server = http.createServer((request, response) => {
    const index = Math.min(received, script.length - 1)
    received += 1
    paths.push(request.url ?? '')
    const fault = script[index]

    // Drain the request body so the client always completes its write before we misbehave.
    request.resume()

    if (fault === undefined || fault.kind === 'hang') {
      return
    }

    switch (fault.kind) {
      case 'reset-before-headers': {
        request.socket.destroy()
        return
      }
      case 'reset-mid-body': {
        response.writeHead(fault.status, {'content-type': 'application/json'})
        response.write(fault.partialBody)
        response.flushHeaders()
        // Destroying rather than ending makes the peer observe a reset instead of a clean
        // end-of-stream, which is what surfaces as ECONNRESET on the client side.
        request.socket.destroy()
        return
      }
      case 'truncated-body': {
        response.writeHead(fault.status, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(fault.partialBody) + 64),
        })
        response.write(fault.partialBody)
        request.socket.end()
        return
      }
      case 'throttled': {
        const payload = JSON.stringify({message: 'rate limit exceeded'})
        response.writeHead(fault.status, {
          'content-type': 'application/json',
          'retry-after': String(fault.retryAfterSeconds),
          'content-length': String(Buffer.byteLength(payload)),
        })
        response.end(payload)
        return
      }
      case 'ok': {
        const payload = JSON.stringify(fault.body)
        response.writeHead(fault.status, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        })
        response.end(payload)
        return
      }
    }
  })

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => received,
    requestPaths: () => [...paths],
    close: async () => {
      for (const socket of openSockets) {
        socket.destroy()
      }
      openSockets.clear()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
