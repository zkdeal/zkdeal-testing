import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { concatHex, keccak256, pad, toHex, zeroHash, type Hex } from 'viem'
import {
  approverLeaf,
  gpuCalibration,
  jsonSafe,
  reconcileGpuName,
  runtimeCodeSizeProblem,
  RUNTIME_CODE_LIMIT_BYTES,
  unanimousApproverPath,
  UNDECLARED_GPU_NAME,
  validateEvidence,
} from '../src/evidence.ts'

const MEMBER = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' as Hex

/// Independent restatement of `roster_root_v5` in `stf-types`: a full tree of
/// `capacity` leaves, empty slots left at the zero word.
function rosterRoot(member: Hex, joinedEpoch: bigint, capacity: number): Hex {
  let level: Hex[] = Array.from({ length: capacity }, (_unused, index) =>
    index === 0
      ? keccak256(
          concatHex([
            pad(toHex(0n), { size: 32 }),
            pad(member, { size: 32 }),
            pad(toHex(joinedEpoch), { size: 32 }),
          ]),
        )
      : zeroHash,
  )
  while (level.length > 1) {
    const next: Hex[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(keccak256(concatHex([level[index]!, level[index + 1]!])))
    }
    level = next
  }
  return level[0]!
}

/// Independent restatement of `RoomManagerBase._verifyPositionalProof`.
function foldPositionalProof(leaf: Hex, index: bigint, proof: readonly Hex[]): Hex {
  let value = leaf
  let cursor = index
  for (const sibling of proof) {
    value =
      cursor % 2n === 0n
        ? keccak256(concatHex([value, sibling]))
        : keccak256(concatHex([sibling, value]))
    cursor >>= 1n
  }
  return value
}

test('the approver leaf matches the Solidity and guest encoding', () => {
  assert.equal(
    approverLeaf(0n, MEMBER, 1n),
    keccak256(
      concatHex([
        pad(toHex(0n), { size: 32 }),
        pad(MEMBER, { size: 32 }),
        pad(toHex(1n), { size: 32 }),
      ]),
    ),
  )
})

test('the single-approver path is derived from the roster root, not hardcoded', () => {
  for (const capacity of [2, 4, 8, 64]) {
    const root = rosterRoot(MEMBER, 1n, capacity)
    const path = unanimousApproverPath(MEMBER, 1n, root)
    assert.equal(path.index, 0n)
    assert.equal(path.joinedEpoch, 1n)
    assert.equal(path.proof.length, Math.log2(capacity))
    assert.equal(foldPositionalProof(approverLeaf(0n, MEMBER, 1n), 0n, path.proof), root)
  }
})

test('a wider roster no longer accepts the depth-one path the runner used to hardcode', () => {
  const root = rosterRoot(MEMBER, 1n, 4)
  assert.notEqual(foldPositionalProof(approverLeaf(0n, MEMBER, 1n), 0n, [zeroHash]), root)
  assert.deepEqual(unanimousApproverPath(MEMBER, 1n, root).proof.length, 2)
})

test('a roster this runner cannot authorize is rejected before a proof is spent', () => {
  assert.throws(
    () => unanimousApproverPath(MEMBER, 1n, keccak256(toHex('a roster with other members'))),
    /single-approver roster/u,
  )
  assert.throws(
    () => unanimousApproverPath(MEMBER, 2n, rosterRoot(MEMBER, 1n, 2)),
    /single-approver roster/u,
  )
})

test('the measured device wins over an unset or placeholder operator label', () => {
  assert.equal(reconcileGpuName(undefined, 'NVIDIA GeForce RTX 4090'), 'NVIDIA GeForce RTX 4090')
  assert.equal(
    reconcileGpuName(UNDECLARED_GPU_NAME, 'NVIDIA GeForce RTX 4090'),
    'NVIDIA GeForce RTX 4090',
  )
  assert.equal(reconcileGpuName('GeForce RTX 4090', 'NVIDIA GeForce RTX 4090'), 'NVIDIA GeForce RTX 4090')
  assert.equal(reconcileGpuName('NVIDIA H100 PCIe', undefined), 'NVIDIA H100 PCIe')
  assert.equal(reconcileGpuName(undefined, undefined), UNDECLARED_GPU_NAME)
})

test('a declared GPU label that names a different device is rejected', () => {
  assert.throws(
    () => reconcileGpuName('NVIDIA H100 PCIe', 'NVIDIA GeForce RTX 4090'),
    /does not name the device/u,
  )
})

test('the calibration block carries the prover device identity and telemetry', () => {
  const calibration = gpuCalibration([10, 30, 20], {
    declaredName: 'NVIDIA GeForce RTX 4090',
    measuredName: 'NVIDIA GeForce RTX 4090',
    measuredUuid: 'GPU-1111',
    utilizationSamplesPercent: [97, 99],
    vramSamplesMiB: [21_000],
    powerSamplesW: [401.5],
    containerDigest: 'sha256:abc',
  })
  assert.equal(calibration.gpuUuid, 'GPU-1111')
  assert.equal(calibration.containerDigest, 'sha256:abc')
  assert.equal(calibration.measuredGpuName, 'NVIDIA GeForce RTX 4090')
  assert.deepEqual(calibration.utilizationSamplesPercent, [97, 99])
  assert.equal(calibration.medianSeconds, 20)
  assert.equal(calibration.maximumSeconds, 30)
  assert.equal(calibration.recommendedProofSeconds, 40)
  assert.equal(calibration.recommendedDeadlineBlocks, 5)
})

test('degenerate sample vectors are refused rather than published', () => {
  assert.throws(() => gpuCalibration([], {}), /at least one measured room proof/u)
  assert.throws(() => gpuCalibration([12, 0], {}), /non-positive elapsed time/u)
  assert.throws(() => gpuCalibration([Number.NaN], {}), /non-positive elapsed time/u)
})

test('the calibration reports spread and says what its sample count can carry', () => {
  const three = gpuCalibration([10, 20, 30], {})
  assert.equal(three.sampleCount, 3)
  assert.equal(three.minimumSeconds, 10)
  assert.equal(three.medianSeconds, 20)
  // With three draws every upper quantile is the maximum; the block says so
  // instead of letting a p99 read as a tail measurement.
  assert.equal(three.p95Seconds, 30)
  assert.equal(three.p99Seconds, 30)
  assert.equal(three.supportsTailClaim, false)
  assert.equal(three.meanSeconds, 20)
  assert.equal(three.standardDeviationSeconds, 10)
  assert.equal(gpuCalibration([17], {}).standardDeviationSeconds, 0)
  const twenty = gpuCalibration(
    Array.from({ length: 20 }, (_unused, index) => index + 1),
    {},
  )
  assert.equal(twenty.supportsTailClaim, true)
  assert.equal(twenty.p95Seconds, 19)
  assert.equal(twenty.p99Seconds, 20)
})

test('the published safety factors are the ones actually applied', () => {
  const calibration = gpuCalibration([40], {})
  const { floorSeconds, margin, headroomSeconds } = calibration.safetyFactors
  assert.equal(
    calibration.recommendedProofSeconds,
    Math.ceil(Math.max(floorSeconds, calibration.maximumSeconds * margin + headroomSeconds)),
  )
  // The floor holds when the GPU is faster than one L1 block.
  assert.equal(gpuCalibration([1], {}).recommendedProofSeconds, floorSeconds)
})

test('machine evidence survives JSON without losing bigint precision', () => {
  assert.deepEqual(
    jsonSafe({
      gasUsed: 8_000_000n,
      block: { number: 2n ** 64n, hashes: [1n, '0xab', true, null] },
    }),
    {
      gasUsed: '8000000',
      block: { number: '18446744073709551616', hashes: ['1', '0xab', true, null] },
    },
  )
})

test('a missing runtime and an oversize runtime are different failures', () => {
  const runtime = (bytes: number) => ({ object: `0x${'ab'.repeat(bytes)}` })
  assert.equal(
    runtimeCodeSizeProblem({ source: 'RoomPoolManager.json', deployedBytecode: runtime(21_518) }),
    null,
  )
  assert.match(
    runtimeCodeSizeProblem({ source: 'IRoomManager.json' }) ?? '',
    /IRoomManager\.json carries no runtime bytecode/u,
  )
  assert.match(
    runtimeCodeSizeProblem({ source: 'Empty.json', deployedBytecode: { object: '0x' } }) ?? '',
    /carries no runtime bytecode/u,
  )
  assert.match(
    runtimeCodeSizeProblem({
      source: 'Huge.json',
      deployedBytecode: runtime(RUNTIME_CODE_LIMIT_BYTES + 1),
    }) ?? '',
    /over the 24576-byte Ethereum limit/u,
  )
})

function completeEvidence(): Record<string, unknown> {
  return {
    decision: 'VERIFIED',
    measurement: {
      workload: 'storage',
      stateCommitment: 'MPT',
      activeSigners: 1,
      participantCapacity: 128,
      residentAccounts: 2,
    },
    prepareRequest: { workload: 'storage', activeSigners: 1 },
    gpuCalibration: gpuCalibration([11, 12, 13], {
      measuredName: 'NVIDIA GeForce RTX 4090',
      measuredUuid: 'GPU-1111',
    }),
    programId: `0x${'11'.repeat(32)}`,
    journalHash: `0x${'22'.repeat(32)}`,
    imageId: 'aabbcc',
    contracts: {
      manager: `0x${'33'.repeat(20)}`,
      pool: `0x${'44'.repeat(20)}`,
      token: `0x${'55'.repeat(20)}`,
    },
    transactions: {
      submit: `0x${'66'.repeat(32)}`,
      submitBlock: '80',
      submitCanonicity: {
        status: 'FINALIZED',
        blockNumber: '80',
        blockHash: `0x${'77'.repeat(32)}`,
        headBlock: '96',
        finalizedBlock: '90',
        finalizedHash: `0x${'88'.repeat(32)}`,
        confirmations: '17',
      },
    },
    roleChecks: { upgradeTimelock: true, serviceManager: true },
    roleDenials: { poolAdminDeployer: false, managerUpgraderDeployer: false },
  }
}

test('a complete acceptance artifact passes the publication gate', () => {
  assert.deepEqual(validateEvidence(completeEvidence()), [])
})

test('an artifact without a workload descriptor or device identity is not publishable', () => {
  const legacy = completeEvidence()
  delete legacy.measurement
  delete legacy.prepareRequest
  delete legacy.imageId
  legacy.gpuCalibration = {
    gpuName: 'Current CUDA GPU',
    samplesSeconds: [11, 12, 13],
    medianSeconds: 12,
    maximumSeconds: 13,
  }
  const problems = validateEvidence(legacy)
  assert.ok(problems.some((problem) => problem.includes('measurement block')))
  assert.ok(problems.some((problem) => problem.includes('prepare request')))
  assert.ok(problems.some((problem) => problem.includes('prover image id')))
  assert.ok(problems.some((problem) => problem.includes('device the prover measured')))
})

test('a failed or malformed artifact is rejected', () => {
  assert.deepEqual(validateEvidence('not an object'), [
    'the evidence file does not contain a JSON object',
  ])
  const failed = { decision: 'FAILED', privateReason: 'the prover degraded' }
  assert.ok(validateEvidence(failed).some((problem) => problem.includes('rather than VERIFIED')))
})

test('an artifact whose role checks are not all true is rejected', () => {
  const evidence = completeEvidence()
  evidence.roleChecks = { upgradeTimelock: true, serviceManager: false }
  assert.ok(
    validateEvidence(evidence).some((problem) => problem.includes('role check in the evidence')),
  )
})

test('an artifact that proves no one was denied power is not publishable', () => {
  const missing = completeEvidence()
  delete missing.roleDenials
  assert.ok(
    validateEvidence(missing).some((problem) => problem.includes('roleDenials block')),
  )
  const empty = completeEvidence()
  empty.roleDenials = {}
  assert.ok(validateEvidence(empty).some((problem) => problem.includes('roleDenials block')))
  const held = completeEvidence()
  held.roleDenials = { poolAdminDeployer: false, managerUpgraderDeployer: true }
  assert.ok(
    validateEvidence(held).some((problem) => problem.includes('in fact holds it')),
  )
})

test('validateEvidence rejects a submit hash without canonical-chain evidence', () => {
  const evidence = completeEvidence()
  evidence.transactions = { submit: `0x${'de'.repeat(32)}` }
  assert.ok(
    validateEvidence(evidence).some((problem) => problem.includes('still canonical')),
  )
})

test('validateEvidence rejects contradictory or weak submit canonicity records', () => {
  const contradictory = completeEvidence()
  const transactions = contradictory.transactions as Record<string, unknown>
  transactions.submitCanonicity = {
    status: 'FINALIZED',
    blockNumber: '91',
    blockHash: `0x${'77'.repeat(32)}`,
    headBlock: '96',
    finalizedBlock: '90',
    finalizedHash: `0x${'88'.repeat(32)}`,
    confirmations: '6',
  }
  assert.ok(
    validateEvidence(contradictory).some((problem) => problem.includes('does not match')),
  )

  const degraded = completeEvidence()
  const degradedTransactions = degraded.transactions as Record<string, unknown>
  degradedTransactions.submitBlock = '80'
  degradedTransactions.submitCanonicity = {
    status: 'DEGRADED_DEPTH',
    reason: 'FINALITY_DELAY',
    blockNumber: '80',
    blockHash: `0x${'77'.repeat(32)}`,
    headBlock: '90',
    finalizedBlock: '70',
    finalizedHash: `0x${'88'.repeat(32)}`,
    confirmations: '11',
  }
  assert.ok(
    validateEvidence(degraded).some((problem) => problem.includes('fewer than 32')),
  )
})
