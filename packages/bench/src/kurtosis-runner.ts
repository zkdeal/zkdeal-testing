import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { encodeAbiParameters, keccak256, toBytes, type AbiParameter } from 'viem'
import { writeHumanFailure, writeHumanReport } from '../../../scripts/lib/human-report.mts'
import { cardDuelReadiness, cardDuelReadinessLine } from './card-readiness.ts'
import { connectChain, fundRoleAccounts } from './chain-ops.ts'
import { deployStack, loadManagerModules } from './deployment.ts'
import { gpuCalibration, jsonSafe, unanimousApproverPath } from './evidence.ts'
import { contractJournal } from './journal.ts'
import {
  configurePool,
  NODE_READY,
  poolStateReader,
  proveStoragePreservingUpgrade,
} from './pool-lifecycle.ts'
import {
  requestJson,
  requestProof,
  type PreparedRoom,
  type ProofResult,
} from './prover-client.ts'
import { startManagedRoom, submitProvedBatch } from './room-lifecycle.ts'
import {
  configuredBudgetSeconds,
  l1RpcUrl,
  outputPath,
  progress,
  remainingBudgetMs,
  runnerBudgetSeconds,
} from './runner-env.ts'
import {
  drainManagedAllocation,
  readRoleSeparation,
  restoreManagedPoolAvailability,
} from './settlement.ts'
import { captureSubmitCanonicity } from './submit-canonicity.ts'

/// The long-lived-room acceptance run: measure real CUDA proofs, stand the
/// contract set up on the Kurtosis L1, drive one room from reservation to a
/// proved batch and a drained allocation, and publish the evidence.

async function run(): Promise<void> {
  if (!l1RpcUrl) throw new Error('the Kurtosis L1 RPC URL is unavailable')
  if (!Number.isFinite(configuredBudgetSeconds) || configuredBudgetSeconds <= 0) {
    throw new Error('RUNNER_TIMEOUT_SECONDS must be a positive number of seconds')
  }
  progress('Loading the Solidity artifacts and funding the role accounts.')
  const chain = await connectChain(l1RpcUrl)
  const { chainId, member, publicClient } = chain
  const modules = await loadManagerModules()
  const { managerAbi } = modules
  await fundRoleAccounts(chain)

  // The literal shape of the measured workload. It travels into the evidence
  // file verbatim so a published timing number can be re-derived and compared
  // across runs instead of standing alone.
  const prepareRequest = {
    deploymentDomain: keccak256(toBytes('zkdeal/kurtosis/demo-v6')),
    roomId: 1,
    l1ChainId: chainId,
    l1InclusionDeadline: Number((await publicClient.getBlockNumber()) + 10_000n),
    authorizationMode: 'unanimous-approvers',
    activeSigners: 1,
    participantCapacity: 128,
    registeredParticipants: 1,
    touchedParticipants: 1,
    touchedContracts: 1,
    residentAccounts: 2,
    residentMirrorVariables: 1,
    importedVariables: 0,
    workload: 'storage',
    stateCommitment: 'mpt',
  } as const
  // '/v5/...' mirrors the prover binary's HTTP surface (changes only in the gated image ceremony).
  const prepared = await requestJson<PreparedRoom>('/v5/rooms/prepare', prepareRequest)

  // A single hardcoded approver can only authorize a roster of exactly one, and
  // its Merkle path depends on the roster capacity the prover chose. Both are
  // checked against the prepared roster root before a proof is spent, so
  // widening the capacity envelope fails here rather than as a `BadApproval`
  // revert a full GPU run later.
  const measurement = prepared.measurement
  if (!measurement) {
    throw new Error('the CUDA prover did not describe the workload it prepared')
  }
  if (measurement.activeSigners !== 1) {
    throw new Error(
      'this acceptance runner authorizes exactly one approver; widen the approver set here first',
    )
  }
  const preparedApproverRoot = prepared.contractConfig?.initialApproverRoot
  if (!preparedApproverRoot) {
    throw new Error('the CUDA prover did not return the prepared approver root')
  }
  const approval = unanimousApproverPath(member.address, 1n, preparedApproverRoot)

  // How many measured room proofs to take. Three is the enclave default that
  // fits the 45-minute budget; no percentile above the median is a tail
  // estimate below MINIMUM_TAIL_CLAIM_SAMPLES, which the calibration block
  // states outright rather than leaving to the reader.
  const configuredSamples = Number(process.env.PROOF_SAMPLES ?? 3)
  if (!Number.isInteger(configuredSamples) || configuredSamples < 1) {
    throw new Error('PROOF_SAMPLES must be a positive whole number of measured room proofs')
  }

  // One physical GPU is one proving slot. Keep the cold registration and hot
  // room proof sequential so the acceptance result does not depend on
  // oversubscribed CUDA contexts or hidden scheduling retries.
  progress('Proving the cold template on the enclave CUDA prover.')
  const coldProof = await requestProof('/v5/cold-templates/prove', prepared.coldRequest)
  // Start one unreported warm-up after the cold proof, then measure the
  // configured number of complete recurring Groth16 requests. The final
  // measured proof is the receipt submitted to Ethereum, so calibration and
  // acceptance share the same production boundary.
  progress('Warming up the persistent prover with one unreported room proof.')
  await requestProof('/v5/rooms/prove', prepared.roomRequest)
  const roomProofSamples: ProofResult[] = []
  for (let sample = 0; sample < configuredSamples; sample += 1) {
    progress(`Measuring room proof ${sample + 1} of ${configuredSamples}.`)
    roomProofSamples.push(await requestProof('/v5/rooms/prove', prepared.roomRequest))
  }
  const roomProof = roomProofSamples.at(-1)!
  if (!roomProof.journal) throw new Error('the room proof omitted its journal')
  const journal = contractJournal(roomProof.journal)
  if (journal.preApproverRoot.toLowerCase() !== preparedApproverRoot.toLowerCase()) {
    throw new Error('the proved roster root does not match the approver path this runner signs')
  }

  // The hand-written journal mapping and the prover's own digest are two
  // independent encodings of one preimage. Comparing them here catches a
  // mismatch before any deployment work, instead of as an opaque seal
  // verification revert a full GPU run later.
  const submitFunction = managerAbi.find(
    (item) => item.type === 'function' && item.name === 'submitBatch',
  )
  if (!submitFunction || submitFunction.type !== 'function') {
    throw new Error('the RoomManager artifact has no submitBatch entry point')
  }
  const submission = submitFunction.inputs[1]
  if (!submission || submission.type !== 'tuple' || !('components' in submission)) {
    throw new Error('the RoomManager submission ABI is incomplete')
  }
  const journalParameter = submission.components[0] as AbiParameter
  if (journalParameter.name !== 'journal') {
    throw new Error('the RoomManager submission tuple does not start with its journal')
  }
  const journalHash = keccak256(encodeAbiParameters([journalParameter], [journal]))
  if (!roomProof.journalHash) {
    throw new Error('the room proof omitted the journal digest it committed')
  }
  if (roomProof.journalHash.toLowerCase() !== journalHash.toLowerCase()) {
    throw new Error(
      'the reconstructed batch journal does not hash to the digest the prover committed',
    )
  }

  // The samples belong to the device the prover measured, not to the label the
  // host typed in, and the slot this run advertises is sized from them rather
  // than from a constant. Both are settled before any deployment work is spent.
  const calibration = gpuCalibration(
    roomProofSamples.map((sample) => (sample.elapsedMs ?? 0) / 1_000),
    {
      declaredName: process.env.GPU_NAME,
      measuredName: roomProof.gpuName,
      measuredUuid: roomProof.gpuUuid,
      utilizationSamplesPercent: roomProof.utilizationSamplesPercent,
      vramSamplesMiB: roomProof.vramSamplesMiB,
      powerSamplesW: roomProof.powerSamplesW,
      containerDigest: roomProof.containerDigest,
    },
  )
  const roomRequest = prepared.roomRequest
  progress('Deploying the contract set to the Kurtosis L1.')

  const deployed = await deployStack(chain, modules, journal, coldProof)
  const {
    registerReceipt,
    upstream,
    adapter,
    intakeFacet,
    importFacet,
    batchFacet,
    validationFacet,
    observationFacet,
    timelock,
    registry,
    vault,
    manager,
    token,
    pool,
  } = deployed

  const reader = poolStateReader(chain, deployed)
  const { deadlineBlocksFromStart, localProofTargetSeconds, publishedPrice } = await configurePool(
    chain,
    deployed,
    reader,
    journal,
    calibration,
  )
  await proveStoragePreservingUpgrade(chain, deployed, reader, publishedPrice)

  const { allocationId, coldTemplateDataBytes, createReceipt } = await startManagedRoom(
    chain,
    deployed,
    reader,
    journal,
    prepared,
    deadlineBlocksFromStart,
  )
  const { room, submitReceipt } = await submitProvedBatch(
    chain,
    deployed,
    journal,
    journalHash,
    approval,
    roomProof,
    roomRequest,
  )
  const { proofDeadlineBlock, startBlock } = await drainManagedAllocation(
    chain,
    deployed,
    reader,
    allocationId,
    deadlineBlocksFromStart,
  )
  const { publicPrice } = await restoreManagedPoolAvailability(chain, deployed, reader)
  const { roleChecks, roleDenials } = await readRoleSeparation(chain, deployed)
  progress('Re-checking the settlement block against the L1 finalized checkpoint.')
  const submitCanonicity = await captureSubmitCanonicity(publicClient, submitReceipt, {
    maxWaitMs: remainingBudgetMs(),
    // This is deliberately opt-in. A normal wait for finality is not a
    // finality-delay incident and must never be silently relabelled as one.
    allowDegradedFinality: process.env.ALLOW_DEGRADED_FINALITY === '1',
  })

  // Whether this stand can also host the hidden-card duel. Read from the image
  // rather than assumed, and never fatal: the room, the proof and the L1
  // transition above are valid evidence with or without the card artifacts.
  const cardDuel = await cardDuelReadiness()
  progress(cardDuelReadinessLine(cardDuel))

  const evidence = {
    decision: 'VERIFIED',
    proofBoundary: 'canonical witness through locally verified Groth16 and accepted L1 call',
    coldProofProfile: coldProof.profile,
    roomProofProfile: roomProof.profile,
    // What was measured, exactly: the workload descriptor the prover derived
    // and the literal request that produced it. Without both, a published
    // timing number cannot be compared across runs or re-derived.
    measurement,
    prepareRequest,
    gpuCalibration: calibration,
    // Every sample's decomposition, not only the submitted one, so proving,
    // compression and wrapping can be compared across the run.
    roomProofProfiles: roomProofSamples.map((sample) => sample.profile),
    // What the calibration recommended and what the run actually advertised.
    // They agree by construction today; recording both keeps that checkable.
    slotSizing: {
      recommendedProofSeconds: calibration.recommendedProofSeconds,
      appliedProofTargetSeconds: localProofTargetSeconds,
      recommendedDeadlineBlocks: calibration.recommendedDeadlineBlocks,
      appliedDeadlineBlocks: deadlineBlocksFromStart,
    },
    managedRoomAvailability: {
      nodeStatus: NODE_READY,
      readySlots: 1,
      priceEpoch: publicPrice[0],
      priceValidUntilBlock: publicPrice[1],
    },
    coldTemplateDataBytes,
    programId: roomProof.programId,
    imageId: roomProof.imageId ?? null,
    cycles: roomProof.cycles ?? null,
    totalCycles: roomProof.totalCycles ?? null,
    segments: roomProof.segments ?? null,
    journalHash,
    exactDeadline: {
      blocksFromStart: deadlineBlocksFromStart,
      startBlock,
      proofDeadlineBlock,
    },
    roleChecks,
    roleDenials,
    cardDuel,
    contracts: {
      upstream,
      adapter,
      timelock,
      registry,
      vault,
      manager,
      intakeFacet,
      importFacet,
      batchFacet,
      validationFacet,
      observationFacet,
      token,
      pool,
    },
    transactions: {
      register: registerReceipt.transactionHash,
      create: createReceipt.transactionHash,
      submit: submitReceipt.transactionHash,
      submitBlock: submitReceipt.blockNumber,
      submitCanonicity,
    },
    gasUsed: {
      register: registerReceipt.gasUsed,
      create: createReceipt.gasUsed,
      submit: submitReceipt.gasUsed,
    },
    terminalState: room,
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(jsonSafe(evidence), null, 2)}\n`, 'utf8')
  writeHumanReport({
    subject: 'Long-lived room Kurtosis acceptance',
    decision: 'The real CUDA proof was accepted by the official local L1 verifier.',
    evidence: 'The cold template was registered and one non-empty two-block room batch advanced.',
    nextAction:
      'Extend the proved fixture across the repeated import, approver, liquidity and claim cycle.',
    artifact: outputPath,
    // The device the prover reported, not a label typed on the host.
    resourceBudget: `One ${calibration.gpuName} CUDA prover over ${calibration.sampleCount} measured proofs; CPU proving and development receipts disabled.`,
  })
}

async function reportFailure(privateReason: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify({ decision: 'FAILED', privateReason })}\n`,
    'utf8',
  )
  writeHumanFailure(
    'Long-lived room Kurtosis acceptance',
    'No proof or L1 transition from this run is accepted as evidence.',
    'Inspect the private Kurtosis artifact, repair the failing boundary, and rerun with CUDA.',
    outputPath,
  )
}

// The enclave kills the container at its own wait, and a killed process writes
// no evidence at all. This deadline fires first, so a degraded prover or a
// stalled devnet still produces a structured, diagnosable failure.
const watchdog = setTimeout(() => {
  void reportFailure(
    `the acceptance run passed its ${runnerBudgetSeconds}s deadline without reaching a decision`,
  ).finally(() => {
    process.exit(1)
  })
}, Math.max(0, remainingBudgetMs()))
watchdog.unref()

run()
  .then(() => {
    clearTimeout(watchdog)
  })
  .catch(async (error: unknown) => {
    clearTimeout(watchdog)
    await reportFailure(error instanceof Error ? error.message : 'unknown failure')
    process.exitCode = 1
  })
  // A failure while writing the failure must still exit non-zero rather than
  // surface as an unhandled rejection.
  .catch(() => {
    process.exitCode = 1
  })
