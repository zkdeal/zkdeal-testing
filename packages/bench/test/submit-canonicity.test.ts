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

test('retries only the fresh-devnet finalized-tag startup condition', async () => {
  let finalizedReads = 0
  const retryingClient = client({
    getBlock: async ({ blockTag }: { blockTag?: string }) => {
      if (blockTag !== 'finalized') return { number: 80n, hash: blockHash }
      finalizedReads += 1
      if (finalizedReads === 1) throw new Error('finalized block not found')
      return { number: 90n, hash: finalizedHash }
    },
  })

  const result = await captureSubmitCanonicity(
    retryingClient,
    { transactionHash, blockNumber: 80n, blockHash },
    { maxWaitMs: 1_000, pollMs: 100 },
  )
  assert.equal(finalizedReads, 2)
  assert.equal(result.status, 'FINALIZED')

  await assert.rejects(
    captureSubmitCanonicity(
      client({
        getBlock: async ({ blockTag }: { blockTag?: string }) => {
          if (blockTag === 'finalized') throw new Error('permission denied')
          return { number: 80n, hash: blockHash }
        },
      }),
      { transactionHash, blockNumber: 80n, blockHash },
      { maxWaitMs: 1_000, pollMs: 100 },
    ),
    /permission denied/u,
  )
})
