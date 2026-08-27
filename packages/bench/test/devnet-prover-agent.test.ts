import assert from 'node:assert/strict'
import test from 'node:test'

import { assertDevnetChainId } from '../src/devnet-prover-agent.ts'

function chainResponse(chainId: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: chainId }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
}

test('the loopback relay admits only the Kurtosis development chain', async () => {
  await assert.doesNotReject(assertDevnetChainId('http://l1.internal:8545', chainResponse('0x7a69')))
  await assert.rejects(
    assertDevnetChainId('http://l1.internal:8545', chainResponse('0x1')),
    /restricted to chain 31337/,
  )
})

test('the loopback relay rejects non-HTTP upstreams', async () => {
  await assert.rejects(
    assertDevnetChainId('file:///private/l1.sock', chainResponse('0x7a69')),
    /valid HTTP\(S\) URL/,
  )
})

