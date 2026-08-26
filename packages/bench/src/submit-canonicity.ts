import type { Hex, PublicClient, TransactionReceipt } from 'viem'

export const DEGRADED_FINALITY_CONFIRMATIONS = 32n

export interface SubmitCanonicity {
  status: 'FINALIZED' | 'DEGRADED_DEPTH'
  reason?: 'FINALITY_DELAY'
  blockNumber: bigint
  blockHash: Hex
  headBlock: bigint
  finalizedBlock: bigint
  finalizedHash: Hex
  confirmations: bigint
}

export interface SubmitCanonicityOptions {
  /** Maximum time to wait for the finalized checkpoint to cover the submit. */
  maxWaitMs?: number
  /** Explicit finality-delay escape hatch; never enabled implicitly. */
  allowDegradedFinality?: boolean
  pollMs?: number
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Re-read a submitted transaction at publication time and bind the evidence to
 * both its canonical block and Ethereum's finalized checkpoint. A receipt from
 * the original submission is not evidence: it can survive locally after its
 * block was reorganized out.
 */
export async function captureSubmitCanonicity(
  client: PublicClient,
  submitted: Pick<TransactionReceipt, 'transactionHash' | 'blockNumber' | 'blockHash'>,
  options: SubmitCanonicityOptions = {},
): Promise<SubmitCanonicity> {
  const deadline = Date.now() + Math.max(0, options.maxWaitMs ?? 0)
  const pollMs = Math.max(100, options.pollMs ?? 12_000)

  for (;;) {
    let refreshed: TransactionReceipt
    try {
      refreshed = await client.getTransactionReceipt({ hash: submitted.transactionHash })
    } catch {
      throw new Error('the accepted submit transaction is no longer present on the canonical L1')
    }
    if (
      refreshed.blockNumber !== submitted.blockNumber ||
      refreshed.blockHash.toLowerCase() !== submitted.blockHash.toLowerCase()
    ) {
      throw new Error('the accepted submit transaction moved to a different L1 block after a reorg')
    }

    const [canonicalBlock, finalized, headBlock] = await Promise.all([
      client.getBlock({ blockNumber: refreshed.blockNumber, includeTransactions: false }),
      client.getBlock({ blockTag: 'finalized', includeTransactions: false }),
      client.getBlockNumber({ cacheTime: 0 }),
    ])
    if (
      !canonicalBlock.hash ||
      canonicalBlock.hash.toLowerCase() !== refreshed.blockHash.toLowerCase()
    ) {
      throw new Error('the accepted submit transaction block is no longer canonical')
    }
    if (finalized.number === null || !finalized.hash) {
      throw new Error('the L1 RPC did not return a usable finalized checkpoint')
    }
    const confirmations =
      headBlock >= refreshed.blockNumber ? headBlock - refreshed.blockNumber + 1n : 0n
    if (refreshed.blockNumber <= finalized.number) {
      return {
        status: 'FINALIZED',
        blockNumber: refreshed.blockNumber,
        blockHash: refreshed.blockHash,
        headBlock,
        finalizedBlock: finalized.number,
        finalizedHash: finalized.hash,
        confirmations,
      }
    }
    if (
      options.allowDegradedFinality === true &&
      confirmations >= DEGRADED_FINALITY_CONFIRMATIONS
    ) {
      return {
        status: 'DEGRADED_DEPTH',
        reason: 'FINALITY_DELAY',
        blockNumber: refreshed.blockNumber,
        blockHash: refreshed.blockHash,
        headBlock,
        finalizedBlock: finalized.number,
        finalizedHash: finalized.hash,
        confirmations,
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the submit block ${refreshed.blockNumber} has not reached the finalized checkpoint ` +
          `${finalized.number}`,
      )
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())))
  }
}
