import { concatHex, encodeAbiParameters, keccak256, zeroHash, type Hex } from 'viem'

/// Pure helpers behind the acceptance runner: the statistics it publishes, the
/// approver path it signs, the pre-flight guards it runs before spending GPU
/// time, and the gate that decides whether an emitted artifact is publishable.

/// The label an operator may type in when the host cannot report a device name.
/// It is a placeholder, not a claim, so it never contradicts the prover.
export const UNDECLARED_GPU_NAME = 'Current CUDA GPU'

/// Roster capacity is `activeSigners.max(2).next_power_of_two()` on the prover
/// side. The runner never assumes a value: it searches the small legal range
/// and keeps the depth whose derived root matches the prepared roster.
const MAXIMUM_APPROVER_TREE_DEPTH = 8

/// The applied slot target is the worst measured proof plus a 25% margin and
/// two seconds of scheduling headroom, never below the twelve seconds one L1
/// block already costs. Named here because an unexplained multiplier in the
/// published artifact is not auditable.
const PROOF_TARGET_FLOOR_SECONDS = 12
const PROOF_TARGET_MARGIN = 1.25
const PROOF_TARGET_HEADROOM_SECONDS = 2
const SECONDS_PER_L1_BLOCK = 12

/// Below this many samples a p95 or p99 is a restatement of the maximum, not a
/// tail estimate. The calibration block says which of the two it published
/// instead of leaving the reader to count the samples.
export const MINIMUM_TAIL_CLAIM_SAMPLES = 20

/// EIP-170. A deployed runtime larger than this is rejected by every mainnet
/// and by the Kurtosis devnet the acceptance run targets.
export const RUNTIME_CODE_LIMIT_BYTES = 24_576

export type GpuIdentity = {
  declaredName?: string
  measuredName?: string
  measuredUuid?: string
  utilizationSamplesPercent?: number[]
  vramSamplesMiB?: number[]
  powerSamplesW?: number[]
  containerDigest?: string
}

function comparableGpuName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/// The evidence file must not attribute timings to a device the prover did not
/// report. An operator-supplied label is kept only when it agrees with the
/// device the proof actually ran on.
export function reconcileGpuName(declared: string | undefined, measured: string | undefined): string {
  const label = declared?.trim()
  const device = measured?.trim()
  if (!device) return label && label.length > 0 ? label : UNDECLARED_GPU_NAME
  if (!label || label.length === 0 || label === UNDECLARED_GPU_NAME) return device
  const left = comparableGpuName(label)
  const right = comparableGpuName(device)
  if (left === right || left.includes(right) || right.includes(left)) return device
  throw new Error(
    'the declared GPU_NAME does not name the device the CUDA prover measured this run on',
  )
}

/// Nearest-rank percentile over an already sorted vector, so every reported
/// quantile is an observed sample rather than an interpolation between two.
function percentile(sorted: number[], rank: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))
  return sorted[index]!
}

export function gpuCalibration(samplesSeconds: number[], identity: GpuIdentity) {
  if (samplesSeconds.length === 0) {
    throw new Error('the GPU calibration requires at least one measured room proof')
  }
  if (samplesSeconds.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
    throw new Error('a measured room proof reported a non-positive elapsed time')
  }
  const sorted = [...samplesSeconds].sort((a, b) => a - b)
  const maximumSeconds = Math.max(...samplesSeconds)
  const meanSeconds = samplesSeconds.reduce((total, sample) => total + sample, 0) / samplesSeconds.length
  // Sample standard deviation; a single draw has no spread to report.
  const standardDeviationSeconds =
    samplesSeconds.length < 2
      ? 0
      : Math.sqrt(
          samplesSeconds.reduce((total, sample) => total + (sample - meanSeconds) ** 2, 0) /
            (samplesSeconds.length - 1),
        )
  const recommendedProofSeconds = Math.ceil(
    Math.max(
      PROOF_TARGET_FLOOR_SECONDS,
      maximumSeconds * PROOF_TARGET_MARGIN + PROOF_TARGET_HEADROOM_SECONDS,
    ),
  )
  return {
    gpuName: reconcileGpuName(identity.declaredName, identity.measuredName),
    declaredGpuName: identity.declaredName ?? null,
    measuredGpuName: identity.measuredName ?? null,
    gpuUuid: identity.measuredUuid ?? null,
    containerDigest: identity.containerDigest ?? null,
    utilizationSamplesPercent: identity.utilizationSamplesPercent ?? [],
    vramSamplesMiB: identity.vramSamplesMiB ?? [],
    powerSamplesW: identity.powerSamplesW ?? [],
    samplesSeconds,
    sampleCount: samplesSeconds.length,
    minimumSeconds: sorted[0]!,
    medianSeconds: percentile(sorted, 50),
    p95Seconds: percentile(sorted, 95),
    p99Seconds: percentile(sorted, 99),
    meanSeconds,
    standardDeviationSeconds,
    maximumSeconds,
    // Says in the artifact what the sample count can carry, so a p99 over three
    // draws is never read as a tail measurement.
    supportsTailClaim: samplesSeconds.length >= MINIMUM_TAIL_CLAIM_SAMPLES,
    minimumTailClaimSamples: MINIMUM_TAIL_CLAIM_SAMPLES,
    safetyFactors: {
      floorSeconds: PROOF_TARGET_FLOOR_SECONDS,
      margin: PROOF_TARGET_MARGIN,
      headroomSeconds: PROOF_TARGET_HEADROOM_SECONDS,
      appliedTo: 'maximumSeconds',
    },
    recommendedProofSeconds,
    recommendedDeadlineBlocks: Math.ceil(
      (recommendedProofSeconds + SECONDS_PER_L1_BLOCK) / SECONDS_PER_L1_BLOCK,
    ),
    boundary:
      'canonical signed two-block batch through locally verified Ethereum Groth16 receipt; L1 broadcast and inclusion excluded',
  }
}

export type GpuCalibration = ReturnType<typeof gpuCalibration>

/// Machine evidence must survive JSON without silently losing precision, so
/// every bigint becomes a decimal string instead of a rounded double.
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    )
  }
  return value
}

/// Pre-flight guard for every artifact the runner deploys. A missing runtime
/// and an EIP-170 violation are different failures with different repairs, so
/// they never share one message.
export function runtimeCodeSizeProblem(module: {
  source?: string
  deployedBytecode?: { object: string }
}): string | null {
  const name = module.source ?? 'a contract module'
  const runtime = module.deployedBytecode?.object
  const bytes = runtime ? (runtime.length - 2) / 2 : 0
  if (bytes <= 0) {
    return `${name} carries no runtime bytecode; the Foundry artifact is interface-only or the build is incomplete`
  }
  if (bytes > RUNTIME_CODE_LIMIT_BYTES) {
    return `${name} has ${bytes} bytes of runtime code, over the ${RUNTIME_CODE_LIMIT_BYTES}-byte Ethereum limit`
  }
  return null
}

export function approverLeaf(index: bigint, member: Hex, joinedEpoch: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'address' }, { type: 'uint64' }],
      [index, member, joinedEpoch],
    ),
  )
}

/// Rebuild the positional Merkle path for the single approver at index 0 of an
/// otherwise empty roster and prove it against the roster root the prover
/// derived. Nothing here is hardcoded to one tree depth, so widening the
/// capacity envelope fails loudly at preparation instead of reverting with
/// `BadApproval` after a full GPU proving run.
export function unanimousApproverPath(
  member: Hex,
  joinedEpoch: bigint,
  approverRoot: Hex,
): { index: bigint; joinedEpoch: bigint; proof: Hex[] } {
  const leaf = approverLeaf(0n, member, joinedEpoch)
  let value = leaf
  let empty: Hex = zeroHash
  const proof: Hex[] = []
  for (let depth = 1; depth <= MAXIMUM_APPROVER_TREE_DEPTH; depth += 1) {
    proof.push(empty)
    value = keccak256(concatHex([value, empty]))
    empty = keccak256(concatHex([empty, empty]))
    if (value.toLowerCase() === approverRoot.toLowerCase()) {
      return { index: 0n, joinedEpoch, proof: [...proof] }
    }
  }
  throw new Error(
    'the prepared approver root is not a single-approver roster this runner can authorize',
  )
}

export type UnanimousApproverPath = ReturnType<typeof unanimousApproverPath>

function isHex(value: unknown, bytes?: number): boolean {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) return false
  return bytes === undefined || value.length === 2 + bytes * 2
}

function canonicalUint(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
  return BigInt(value)
}

/// Gate for the emitted acceptance artifact. It fails a run whose evidence
/// cannot be attributed to a workload and a device, which is the property the
/// published timing numbers depend on.
export function validateEvidence(raw: unknown): string[] {
  const problems: string[] = []
  const report = (problem: string) => problems.push(problem)
  if (!raw || typeof raw !== 'object') {
    return ['the evidence file does not contain a JSON object']
  }
  const evidence = raw as Record<string, unknown>
  if (evidence.decision !== 'VERIFIED') {
    report(`the evidence decision is ${JSON.stringify(evidence.decision)} rather than VERIFIED`)
  }
  const measurement = evidence.measurement as Record<string, unknown> | undefined
  if (!measurement || typeof measurement !== 'object') {
    report('the evidence carries no measurement block describing the proved workload')
  } else {
    for (const field of [
      'workload',
      'stateCommitment',
      'activeSigners',
      'participantCapacity',
      'residentAccounts',
    ]) {
      if (measurement[field] === undefined || measurement[field] === null) {
        report(`the measurement block is missing ${field}`)
      }
    }
  }
  if (!evidence.prepareRequest || typeof evidence.prepareRequest !== 'object') {
    report('the evidence does not record the prepare request that produced the run')
  }
  const calibration = evidence.gpuCalibration as Record<string, unknown> | undefined
  if (!calibration || typeof calibration !== 'object') {
    report('the evidence carries no gpuCalibration block')
  } else {
    const samples = calibration.samplesSeconds
    if (!Array.isArray(samples) || samples.length === 0) {
      report('the gpuCalibration block records no proof samples')
    } else if (samples.some((sample) => typeof sample !== 'number' || !(sample > 0))) {
      report('the gpuCalibration block records a non-positive proof sample')
    }
    if (typeof calibration.gpuName !== 'string' || calibration.gpuName.length === 0) {
      report('the gpuCalibration block names no GPU')
    }
    if (calibration.measuredGpuName === undefined) {
      report('the gpuCalibration block does not record the device the prover measured')
    }
  }
  if (!isHex(evidence.programId, 32)) report('the evidence programId is not a 32-byte hex digest')
  if (!isHex(evidence.journalHash, 32)) {
    report('the evidence journalHash is not a 32-byte hex digest')
  }
  if (typeof evidence.imageId !== 'string' || evidence.imageId.length === 0) {
    report('the evidence does not record the prover image id')
  }
  const contracts = evidence.contracts as Record<string, unknown> | undefined
  for (const name of ['manager', 'pool', 'token']) {
    if (!contracts || !isHex(contracts[name], 20)) {
      report(`the evidence does not record a deployed ${name} address`)
    }
  }
  const transactions = evidence.transactions as Record<string, unknown> | undefined
  if (!transactions || !isHex(transactions.submit, 32)) {
    report('the evidence does not record the accepted submit transaction')
  } else {
    const canonicity = transactions.submitCanonicity as Record<string, unknown> | undefined
    if (!canonicity || typeof canonicity !== 'object') {
      report('the evidence does not prove the submit transaction is still canonical')
    } else {
      const blockNumber = canonicalUint(canonicity.blockNumber)
      const finalizedBlock = canonicalUint(canonicity.finalizedBlock)
      const headBlock = canonicalUint(canonicity.headBlock)
      const confirmations = canonicalUint(canonicity.confirmations)
      if (!isHex(canonicity.blockHash, 32)) {
        report('the submit canonicity record has no canonical block hash')
      }
      if (!isHex(canonicity.finalizedHash, 32)) {
        report('the submit canonicity record has no finalized checkpoint hash')
      }
      if (blockNumber === null || transactions.submitBlock !== canonicity.blockNumber) {
        report('the submit canonicity block does not match the accepted submit block')
      }
      if (finalizedBlock === null || headBlock === null || confirmations === null) {
        report('the submit canonicity record has malformed checkpoint heights')
      } else if (blockNumber !== null) {
        const expectedConfirmations = headBlock >= blockNumber ? headBlock - blockNumber + 1n : 0n
        if (confirmations !== expectedConfirmations) {
          report('the submit canonicity confirmation count is inconsistent with its block heights')
        }
        if (canonicity.status === 'FINALIZED') {
          if (blockNumber > finalizedBlock) {
            report('the submit transaction is labelled finalized above the finalized checkpoint')
          }
        } else if (canonicity.status === 'DEGRADED_DEPTH') {
          if (canonicity.reason !== 'FINALITY_DELAY') {
            report('degraded submit canonicity does not name the finality-delay fallback')
          }
          if (confirmations < 32n) {
            report('degraded submit canonicity has fewer than 32 confirmations')
          }
        } else {
          report('the submit canonicity record has no recognized finality status')
        }
      }
    }
  }
  const roleChecks = evidence.roleChecks as Record<string, unknown> | undefined
  if (!roleChecks || typeof roleChecks !== 'object') {
    report('the evidence carries no roleChecks block')
  } else if (Object.values(roleChecks).some((value) => value !== true)) {
    report('a governance or service role check in the evidence is not true')
  }
  // Roles granted as intended is half the claim; the other half is that the
  // deploying key kept none of them.
  const roleDenials = evidence.roleDenials as Record<string, unknown> | undefined
  if (!roleDenials || typeof roleDenials !== 'object' || Object.keys(roleDenials).length === 0) {
    report('the evidence carries no roleDenials block proving the deployer holds no power')
  } else if (Object.values(roleDenials).some((value) => value !== false)) {
    report('an account the evidence claims holds no role in fact holds it')
  }
  return problems
}
