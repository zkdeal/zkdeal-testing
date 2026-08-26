/// Pure helpers behind the per-example acceptance runner: the case → preset
/// script table the enclave and the runner must agree on, the flow-fee
/// arithmetic restated from RoomManagerIntakeFacet.queueDeposit, and the gate
/// that decides whether an emitted example artifact is publishable.

/** Which coordinator presets each example case checkpoints, in order. Mirrors
 * EXAMPLE_CASE_PRESETS in package/main.star: amm-mev runs the naive sandwich
 * room first and the commit-reveal protected room second, so one enclave
 * carries both sides of the ordering story. */
export const EXAMPLE_CASE_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'amm-mev': Object.freeze(['amm-naive', 'amm']),
  auction: Object.freeze(['auction']),
  shop: Object.freeze(['shop']),
})

export const EXAMPLE_CASES: readonly string[] = Object.freeze(Object.keys(EXAMPLE_CASE_PRESETS))

/** The wired protocol flow fee. The deployment sets the contract-constant
 * ceiling (`MAX_PROTOCOL_FEE_BPS`, RoomManagerBase.sol), so a stand reporting
 * any other rate either forgot the wiring or drifted from the deployment. */
export const PROTOCOL_FEE_BPS = 100

/** Fee basis restated from RoomManagerBase.FEE_DENOMINATOR_BPS. */
export const FEE_DENOMINATOR_BPS = 10_000n

/** Least prover results the shared queue must have carried before the queue
 * evidence counts: one cold-template proof and one room proof at minimum. */
export const MINIMUM_QUEUE_JOBS_DONE = 2

/** The skim `queueDeposit` takes, floor math exactly as the facet computes it. */
export function expectedFeeWei(depositWei: bigint, feeBps: number): bigint {
  return (depositWei * BigInt(feeBps)) / FEE_DENOMINATOR_BPS
}

function isTransactionHash(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

/** A uint that survived `jsonSafe`: a decimal string with no sign or fraction. */
function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}

/// Gate for the emitted example artifact. It fails a run whose evidence cannot
/// be tied to the case's preset script, a real fee-bearing deposit, and - when
/// the queue block is present at all - a live prover queue, which are the
/// properties the enclave's example step publishes.
export function validateExampleEvidence(raw: unknown): string[] {
  const problems: string[] = []
  const report = (problem: string) => problems.push(problem)
  if (!raw || typeof raw !== 'object') {
    return ['the evidence file does not contain a JSON object']
  }
  const evidence = raw as Record<string, unknown>
  if (evidence.decision !== 'VERIFIED') {
    report(`the evidence decision is ${JSON.stringify(evidence.decision)} rather than VERIFIED`)
  }
  const exampleCase = evidence.case
  const script =
    typeof exampleCase === 'string' ? EXAMPLE_CASE_PRESETS[exampleCase] : undefined
  if (!script) {
    report(
      `the evidence case is ${JSON.stringify(exampleCase)} rather than one of ${EXAMPLE_CASES.join(', ')}`,
    )
  }
  const presets = evidence.presets
  if (!Array.isArray(presets) || presets.length === 0) {
    report('the evidence records no checkpointed presets')
  } else {
    if (script && presets.length !== script.length) {
      report(
        `the ${String(exampleCase)} case checkpoints ${script.length} preset(s); the evidence records ${presets.length}`,
      )
    }
    presets.forEach((entry, index) => {
      const preset = (entry ?? {}) as Record<string, unknown>
      const expectedId = script?.[index]
      if (typeof preset.presetId !== 'string' || preset.presetId.length === 0) {
        report(`preset ${index} names no presetId`)
      } else if (expectedId && preset.presetId !== expectedId) {
        report(
          `preset ${index} is ${preset.presetId} where the ${String(exampleCase)} script expects ${expectedId}`,
        )
      }
      if (!isDecimalString(preset.chainRoomId)) {
        report(`preset ${index} carries no on-chain room id`)
      }
      if (!isTransactionHash(preset.checkpointTx)) {
        report(`preset ${index} carries no 32-byte checkpoint transaction hash`)
      }
    })
  }
  const fee = evidence.fee as Record<string, unknown> | undefined
  if (!fee || typeof fee !== 'object') {
    report('the evidence carries no fee block proving the protocol flow-fee skim')
  } else {
    if (fee.feeBps !== PROTOCOL_FEE_BPS) {
      report(
        `the fee block claims ${JSON.stringify(fee.feeBps)} bps rather than the wired ${PROTOCOL_FEE_BPS}`,
      )
    }
    if (!isDecimalString(fee.depositWei) || BigInt(fee.depositWei as string) === 0n) {
      report('the fee block records no positive deposit amount')
    }
    if (!isDecimalString(fee.feeAccruedDeltaWei)) {
      report('the fee block records no accrued-fee delta')
    }
    if (
      typeof fee.feeBps === 'number' &&
      isDecimalString(fee.depositWei) &&
      isDecimalString(fee.feeAccruedDeltaWei)
    ) {
      const expected = expectedFeeWei(BigInt(fee.depositWei), fee.feeBps)
      if (expected === 0n) {
        report('the recorded deposit is too small to accrue any fee at the recorded rate')
      } else if (BigInt(fee.feeAccruedDeltaWei) !== expected) {
        report(
          `the accrued-fee delta ${fee.feeAccruedDeltaWei} does not equal the ${String(fee.feeBps)} bps skim ${expected} of the recorded deposit`,
        )
      }
    }
  }
  // The queue block is present exactly when the enclave ran the shared prove
  // queue. Absent means the queue was off; present-but-empty means the queue
  // ran and nothing pulled from it, which is a liveness failure, not a
  // configuration.
  const queue = evidence.queue as Record<string, unknown> | null | undefined
  if (queue !== undefined && queue !== null) {
    if (typeof queue !== 'object') {
      report('the queue evidence is not an object')
    } else {
      const nodes = queue.nodes
      if (!Array.isArray(nodes) || nodes.length === 0) {
        report('the queue evidence is present but names no prover nodes')
      } else {
        nodes.forEach((entry, index) => {
          const node = (entry ?? {}) as Record<string, unknown>
          if (typeof node.nodeId !== 'string' || node.nodeId.length === 0) {
            report(`queue node ${index} names no nodeId`)
          }
          if (!Number.isInteger(node.jobsDone) || (node.jobsDone as number) < 0) {
            report(`queue node ${index} records no jobsDone count`)
          }
        })
        const total = nodes.reduce(
          (sum: number, entry) =>
            sum + (Number.isInteger((entry as Record<string, unknown>)?.jobsDone)
              ? ((entry as Record<string, unknown>).jobsDone as number)
              : 0),
          0,
        )
        if (queue.totalJobsDone !== total) {
          report('the recorded totalJobsDone does not equal the sum over the queue nodes')
        }
        if (total < MINIMUM_QUEUE_JOBS_DONE) {
          report(
            `the queue carried ${total} finished job(s); at least ${MINIMUM_QUEUE_JOBS_DONE} are required`,
          )
        }
      }
      const heartbeat = queue.heartbeat as Record<string, unknown> | null | undefined
      if (heartbeat !== undefined && heartbeat !== null) {
        if (
          !isDecimalString(heartbeat.lastHealthyBlockBefore) ||
          !isDecimalString(heartbeat.lastHealthyBlockAfter)
        ) {
          report('the heartbeat evidence records no before/after healthy blocks')
        } else if (
          BigInt(heartbeat.lastHealthyBlockAfter) <= BigInt(heartbeat.lastHealthyBlockBefore)
        ) {
          report('the on-chain heartbeat did not advance across the observed wait')
        }
      }
    }
  }
  return problems
}
