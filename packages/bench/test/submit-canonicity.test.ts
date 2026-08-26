import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicClient } from 'viem'
import { captureSubmitCanonicity } from '../src/submit-canonicity.ts'

const transactionHash = `0x${'11'.repeat(32)}` as const
const blockHash = `0x${'22'.repeat(32)}` as const
const finalizedHash = `0x${'33'.repeat(32)}` as const

function client(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getTransactionReceipt: async () => ({
      transactionHash,
      blockNumber: 80n,
      blockHash,
    }),
    getBlock: async ({ blockTag }: { blockTag?: string }) =>
      blockTag === 'finalized'
        ? { number: 90n, hash: finalizedHash }
        : { number: 80n, hash: blockHash },
    getBlockNumber: async () => 96n,
    ...overrides,
  } as unknown as PublicClient
}

test('captures a hash-verified submit beneath the finalized checkpoint', async () => {
  const result = await captureSubmitCanonicity(client(), {
    transactionHash,
    blockNumber: 80n,
    blockHash,
  })
  assert.deepEqual(result, {
    status: 'FINALIZED',
    blockNumber: 80n,
    blockHash,
    headBlock: 96n,
    finalizedBlock: 90n,
    finalizedHash,
    confirmations: 17n,
  })
})

test('rejects a submit receipt that disappeared or changed block', async () => {
  await assert.rejects(
    captureSubmitCanonicity(
      client({ getTransactionReceipt: async () => Promise.reject(new Error('not found')) }),
      { transactionHash, blockNumber: 80n, blockHash },
    ),
    /no longer present/u,
  )
  await assert.rejects(
    captureSubmitCanonicity(
      client({
        getTransactionReceipt: async () => ({
          transactionHash,
          blockNumber: 81n,
          blockHash: `0x${'44'.repeat(32)}`,
        }),
      }),
      { transactionHash, blockNumber: 80n, blockHash },
    ),
    /different L1 block/u,
  )
})
