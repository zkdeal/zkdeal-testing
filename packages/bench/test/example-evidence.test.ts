import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseEther } from 'viem'
import {
  EXAMPLE_CASE_PRESETS,
  expectedFeeWei,
  MINIMUM_QUEUE_JOBS_DONE,
  PROTOCOL_FEE_BPS,
  validateExampleEvidence,
} from '../src/example-evidence.ts'

const CHECKPOINT_TX = `0x${'ab'.repeat(32)}`

/// A publishable amm-mev artifact: two presets in script order, the 100 bps
/// skim on a 0.1 ether deposit, and a live queue with an advanced heartbeat.
function completeEvidence(): Record<string, unknown> {
  return {
    decision: 'VERIFIED',
    case: 'amm-mev',
    presets: [
      {
        presetId: 'amm-naive',
        templateId: 'tpl-1111',
        roomId: 'room-1111',
        chainRoomId: '2',
        checkpointTx: CHECKPOINT_TX,
        checkpointBlock: '77',
      },
      {
        presetId: 'amm',
        templateId: 'tpl-2222',
        roomId: 'room-2222',
        chainRoomId: '3',
        checkpointTx: `0x${'cd'.repeat(32)}`,
        checkpointBlock: '91',
      },
    ],
    fee: {
      chainRoomId: '2',
      feeBps: PROTOCOL_FEE_BPS,
      depositWei: parseEther('0.1').toString(),
      feeAccruedDeltaWei: parseEther('0.001').toString(),
      depositTransaction: `0x${'ef'.repeat(32)}`,
    },
    queue: {
      nodes: [
        { nodeId: 'kurtosis-4090-node', lastLeaseAt: 'T', lastResultAt: 'T', jobsDone: 3 },
      ],
      totalJobsDone: 3,
      heartbeat: {
        nodeId: `0x${'11'.repeat(32)}`,
        lastHealthyBlockBefore: '120',
        lastHealthyBlockAfter: '126',
        observedSeconds: 35,
      },
    },
  }
}

test('the fee arithmetic restates the facet: 100 bps of 0.1 ether is 0.001 ether', () => {
  assert.equal(expectedFeeWei(parseEther('0.1'), PROTOCOL_FEE_BPS), parseEther('0.001'))
  // Floor math, exactly as queueDeposit computes it: 99 wei at 100 bps pays 0.
  assert.equal(expectedFeeWei(99n, PROTOCOL_FEE_BPS), 0n)
})

test('every case script names at least one preset and amm-mev runs both rooms', () => {
  for (const [caseId, script] of Object.entries(EXAMPLE_CASE_PRESETS)) {
    assert.ok(script.length >= 1, `${caseId} has an empty preset script`)
  }
  assert.deepEqual(EXAMPLE_CASE_PRESETS['amm-mev'], ['amm-naive', 'amm'])
})

test('a complete example artifact passes the publication gate', () => {
  assert.deepEqual(validateExampleEvidence(completeEvidence()), [])
})

test('an artifact without a queue block is publishable when the queue was off', () => {
  const evidence = completeEvidence()
  delete evidence.queue
  assert.deepEqual(validateExampleEvidence(evidence), [])
})

test('a failed or malformed artifact is rejected', () => {
  assert.deepEqual(validateExampleEvidence('not an object'), [
    'the evidence file does not contain a JSON object',
  ])
  const failed = { decision: 'FAILED', case: 'shop', privateReason: 'the coordinator degraded' }
  const problems = validateExampleEvidence(failed)
  assert.ok(problems.some((problem) => problem.includes('rather than VERIFIED')))
})

test('an unknown case and a preset list that strays from the script are rejected', () => {
  const unknown = completeEvidence()
  unknown.case = 'poker'
  assert.ok(
    validateExampleEvidence(unknown).some((problem) => problem.includes('rather than one of')),
  )
  const reordered = completeEvidence()
  ;(reordered.presets as Array<Record<string, unknown>>).reverse()
  assert.ok(
    validateExampleEvidence(reordered).some((problem) =>
      problem.includes("expects amm-naive"),
    ),
  )
  const short = completeEvidence()
  ;(short.presets as unknown[]).pop()
  assert.ok(
    validateExampleEvidence(short).some((problem) => problem.includes('checkpoints 2 preset(s)')),
  )
})

test('a truncated or malformed checkpoint transaction hash is rejected', () => {
  const evidence = completeEvidence()
  const presets = evidence.presets as Array<Record<string, unknown>>
  presets[0]!.checkpointTx = CHECKPOINT_TX.slice(0, 20)
  assert.ok(
    validateExampleEvidence(evidence).some((problem) =>
      problem.includes('32-byte checkpoint transaction hash'),
    ),
  )
  presets[0]!.checkpointTx = `0x${'zz'.repeat(32)}`
  assert.ok(
    validateExampleEvidence(evidence).some((problem) =>
      problem.includes('32-byte checkpoint transaction hash'),
    ),
  )
})

test('a fee delta that contradicts the recorded rate is rejected', () => {
  const wrongDelta = completeEvidence()
  ;(wrongDelta.fee as Record<string, unknown>).feeAccruedDeltaWei = parseEther('0.002').toString()
  assert.ok(
    validateExampleEvidence(wrongDelta).some((problem) => problem.includes('does not equal')),
  )
  const wrongRate = completeEvidence()
  ;(wrongRate.fee as Record<string, unknown>).feeBps = 50
  assert.ok(
    validateExampleEvidence(wrongRate).some((problem) => problem.includes('rather than the wired')),
  )
  const missing = completeEvidence()
  delete missing.fee
  assert.ok(
    validateExampleEvidence(missing).some((problem) => problem.includes('no fee block')),
  )
})

test('a queue block that is present but empty is a liveness failure, not a pass', () => {
  const empty = completeEvidence()
  ;(empty.queue as Record<string, unknown>).nodes = []
  assert.ok(
    validateExampleEvidence(empty).some((problem) => problem.includes('names no prover nodes')),
  )
  const idle = completeEvidence()
  ;(idle.queue as Record<string, unknown>).nodes = [
    { nodeId: 'kurtosis-4090-node', lastLeaseAt: null, lastResultAt: null, jobsDone: 1 },
  ]
  ;(idle.queue as Record<string, unknown>).totalJobsDone = 1
  assert.ok(
    validateExampleEvidence(idle).some((problem) =>
      problem.includes(`at least ${MINIMUM_QUEUE_JOBS_DONE} are required`),
    ),
  )
  const inconsistent = completeEvidence()
  ;(inconsistent.queue as Record<string, unknown>).totalJobsDone = 9
  assert.ok(
    validateExampleEvidence(inconsistent).some((problem) =>
      problem.includes('does not equal the sum'),
    ),
  )
})

test('a heartbeat that did not advance is rejected', () => {
  const stalled = completeEvidence()
  const heartbeat = (stalled.queue as Record<string, Record<string, unknown>>).heartbeat!
  heartbeat.lastHealthyBlockAfter = heartbeat.lastHealthyBlockBefore
  assert.ok(
    validateExampleEvidence(stalled).some((problem) => problem.includes('did not advance')),
  )
})
