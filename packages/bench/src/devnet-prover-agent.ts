/**
 * Kurtosis-only prover-agent entrypoint.
 *
 * The prover agent deliberately accepts a development private key only when
 * its L1 RPC URL is loopback. Kurtosis gives services private DNS names, so
 * this process verifies that the enclave RPC really is chain 31337 and then
 * relays JSON-RPC over a listener bound solely to 127.0.0.1. Production agent
 * images keep their existing durable-coordinator requirement unchanged.
 */

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

const DEV_CHAIN_ID = 31_337n
const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_PORT = 8_545
const MAX_RPC_BODY_BYTES = 8 * 1024 * 1024

type Fetch = typeof fetch

function rpcRequest(method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] })
}

export async function assertDevnetChainId(upstream: string, fetchImpl: Fetch = fetch): Promise<void> {
  let url: URL
  try {
    url = new URL(upstream)
  } catch {
    throw new Error('DEVNET_L1_RPC_UPSTREAM must be a valid HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('DEVNET_L1_RPC_UPSTREAM must be a valid HTTP(S) URL')
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rpcRequest('eth_chainId'),
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error('devnet L1 RPC chain-id probe failed')
  const payload = (await response.json()) as { result?: unknown }
  if (typeof payload.result !== 'string' || BigInt(payload.result) !== DEV_CHAIN_ID) {
    throw new Error('the loopback L1 relay is restricted to chain 31337')
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_RPC_BODY_BYTES) throw new Error('JSON-RPC request exceeds the relay limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function fail(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32_000, message } }))
}

export async function startDevnetLoopbackRelay(upstream: string): Promise<ReturnType<typeof createServer>> {
  await assertDevnetChainId(upstream)
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      fail(response, 405, 'the devnet relay accepts JSON-RPC POST requests only')
      return
    }
    try {
      const body = await readBody(request)
      const forwarded = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
      response.writeHead(forwarded.status, {
        'content-type': forwarded.headers.get('content-type') ?? 'application/json',
      })
      response.end(Buffer.from(await forwarded.arrayBuffer()))
    } catch {
      fail(response, 502, 'the devnet L1 RPC relay request failed')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

async function main(): Promise<void> {
  const upstream = process.env.DEVNET_L1_RPC_UPSTREAM?.trim()
  if (!upstream) throw new Error('DEVNET_L1_RPC_UPSTREAM is required')
  const relay = await startDevnetLoopbackRelay(upstream)

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    L1_RPC_URL: `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`,
  }
  delete childEnv.DEVNET_L1_RPC_UPSTREAM
  const agent = spawn('pnpm', ['exec', 'tsx', 'src/agent.ts'], {
    cwd: '/app/prover-node/agent',
    env: childEnv,
    stdio: 'inherit',
  })
  const stop = (signal: NodeJS.Signals): void => {
    agent.kill(signal)
    relay.close()
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
  const exitCode = await new Promise<number>((resolve, reject) => {
    agent.once('error', reject)
    agent.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
  await new Promise<void>((resolve) => relay.close(() => resolve()))
  process.exitCode = exitCode
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Decision: devnet prover-agent startup failed: ${String(error)}\n`)
    process.exitCode = 1
  })
}
