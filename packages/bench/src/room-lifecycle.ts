import {
  keccak256,
  parseEther,
  parseSignature,
  toBytes,
  toHex,
  zeroAddress,
  type Hex,
} from 'viem'
import { expectState, type ChainContext } from './chain-ops.ts'
import type { DeployedStack } from './deployment.ts'
import type { UnanimousApproverPath } from './evidence.ts'
import type { ContractJournal } from './journal.ts'
import {
  DEFAULT_PRODUCTION_CONFIRMATIONS,
  productionConfirmationDepth,
} from './confirmation-policy.ts'
import {
  ALLOCATION_USED,
  nodeId,
  presetId,
  slotId,
  type AllocationState,
  type PoolStateReader,
} from './pool-lifecycle.ts'
import type { PreparedRoom, ProofResult } from './prover-client.ts'
import { progress } from './runner-env.ts'

/// The measured room itself: reserving and starting it against the pool with an
/// EIP-2612 permit, then submitting the proved batch to the L1 room manager and
/// confirming the terminal state it claims.

/// Gas ceiling for the proved submission. Estimation is bypassed because
/// Groth16 verification forwards under EIP-150; the value is compared against
/// `gasUsed` on failure so exhaustion is never reported as a revert.
const SUBMIT_GAS_LIMIT = 8_000_000n

export async function startManagedRoom(
  chain: ChainContext,
  deployed: DeployedStack,
  reader: PoolStateReader,
  journal: ContractJournal,
  prepared: PreparedRoom,
  deadlineBlocksFromStart: bigint,
) {
  const { accounts, chainId, publicClient, wallets } = chain
  const confirmations = productionConfirmationDepth(DEFAULT_PRODUCTION_CONFIRMATIONS)
  const {
    intakeFacet,
    intakeFacetArtifact,
    manager,
    managerAbi,
    pool,
    poolArtifact,
    token,
    tokenArtifact,
  } = deployed
  const { sent } = deployed.ops
  const { poolRead, readNode } = reader

  await sent(
    wallets.treasury,
    token,
    tokenArtifact.abi,
    'transfer',
    [accounts.customer.address, parseEther('1000')],
  )
  const quote = (await publicClient.readContract({
    address: pool,
    abi: poolArtifact.abi,
    functionName: 'quote',
    args: [nodeId, slotId, deadlineBlocksFromStart, 1n],
  })) as readonly [bigint, bigint, bigint]
  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3_600)
  const permitNonce = (await publicClient.readContract({
    address: token,
    abi: tokenArtifact.abi,
    functionName: 'nonces',
    args: [accounts.customer.address],
  })) as bigint
  const permitSignature = parseSignature(
    await accounts.customer.signTypedData({
      domain: {
        name: 'zkdeal Access Token',
        version: '1',
        chainId,
        verifyingContract: token,
      },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: accounts.customer.address,
        spender: pool,
        value: quote[2],
        nonce: permitNonce,
        deadline: permitDeadline,
      },
    }),
  )
  // The published bytes must be the prover's exact framed canonical witness:
  // the v6 registry statement binds their keccak256 as the genesis data hash,
  // and a JSON re-serialization of the request would hash differently.
  const canonicalColdTemplateData = prepared.contractConfig?.canonicalColdTemplateData
  if (!canonicalColdTemplateData) {
    throw new Error('the prepared room omitted the canonical cold template bytes the registry binds')
  }
  const coldTemplateDataBytes = (canonicalColdTemplateData.length - 2) / 2
  // The contract's own cap is skipped for unanimous rooms, so the whole cold
  // witness travels into L1 calldata unbounded. Read the limit from the
  // deployed facet and refuse to publish past it here, where the cause is
  // still legible, instead of failing gas estimation with no reason given.
  const maximumColdTemplateDataBytes = (await publicClient.readContract({
    address: intakeFacet,
    abi: intakeFacetArtifact.abi,
    functionName: 'MAX_COLD_TEMPLATE_DATA_BYTES',
  })) as bigint
  if (BigInt(coldTemplateDataBytes) > maximumColdTemplateDataBytes) {
    throw new Error(
      `the cold template witness is ${coldTemplateDataBytes} bytes, over the ${maximumColdTemplateDataBytes} the room manager accepts`,
    )
  }
  progress('Reserving and starting the managed room with an EIP-2612 permit.')
  const createReceipt = await sent(
    wallets.customer,
    pool,
    poolArtifact.abi,
    'reserveAndStartWithPermit',
    [
      {
        nodeId,
        slotId,
        presetId,
        deadlineBlocksFromStart,
        priceEpoch: 1n,
        maxTokenCharge: quote[2],
      },
      {
        config: {
          policyHash: journal.policyHash,
          adapterPolicyRoot: keccak256(toBytes('no-imports-in-this-batch')),
          importPublisher: accounts.templateAdmin.address,
          minimumImportConfirmations: confirmations,
          minimumDepositConfirmations: confirmations,
          inactivityTimeout: 86_400n,
          authorizationMode: journal.authorizationMode,
          admissionSigner:
            journal.authorizationMode === 1 ? accounts.service.address : zeroAddress,
          maximumAdmissionWindow: journal.authorizationMode === 1 ? 50n : 0n,
          minimumServiceBond: journal.authorizationMode === 1 ? 1n : 0n,
          omissionPenalty: journal.authorizationMode === 1 ? 1n : 0n,
          participantCapacity: journal.participantCapacity,
        },
        coldTemplateId: journal.coldTemplateId,
        initialApproverRoot: journal.preApproverRoot,
        initialActiveApproverCount: journal.preActiveCount,
        initialParticipantRoot: journal.preParticipantRoot,
        initialParticipantCount: journal.preParticipantCount,
        canonicalColdTemplateData,
        supportedAssets: [zeroAddress],
      },
      {
        value: quote[2],
        deadline: permitDeadline,
        v: Number(permitSignature.v),
        r: permitSignature.r,
        s: permitSignature.s,
      },
    ],
  )
  const allocationId = (await publicClient.readContract({
    address: manager,
    abi: managerAbi,
    functionName: 'managedAllocationId',
    args: [journal.roomId],
  })) as Hex
  const createdAllocation = await poolRead<AllocationState>('allocationState', [allocationId])
  expectState('reserveAndStartWithPermit', createdAllocation.status, ALLOCATION_USED)
  expectState(
    'reserveAndStartWithPermit',
    createdAllocation.user.toLowerCase(),
    accounts.customer.address.toLowerCase(),
  )
  expectState('reserveAndStartWithPermit', createdAllocation.roomId, journal.roomId)
  expectState('reserveAndStartWithPermit', (await readNode()).activeAllocations, 1n)
  // Anchoring is checked against the block the room was actually created in,
  // not against the contract's own two adjacent assignments of `block.number`,
  // which would make the equality an identity.
  expectState('the room start block', createdAllocation.startBlock, createReceipt.blockNumber)
  expectState(
    'the managed proof deadline',
    createdAllocation.proofDeadlineBlock,
    createReceipt.blockNumber + deadlineBlocksFromStart,
  )

  return { createReceipt, allocationId, coldTemplateDataBytes }
}

export async function submitProvedBatch(
  chain: ChainContext,
  deployed: DeployedStack,
  journal: ContractJournal,
  journalHash: Hex,
  approval: UnanimousApproverPath,
  roomProof: ProofResult,
  roomRequest: PreparedRoom['roomRequest'],
) {
  const { chainId, member, publicClient, wallet } = chain
  const { manager, managerAbi } = deployed

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const signature = await member.signTypedData({
    domain: { name: 'ZkdealRoom', version: '6', chainId, verifyingContract: manager },
    types: {
      BatchApproval: [
        { name: 'roomId', type: 'uint64' },
        { name: 'batchIndex', type: 'uint64' },
        { name: 'journalHash', type: 'bytes32' },
        { name: 'approverRoot', type: 'bytes32' },
        { name: 'approverEpoch', type: 'uint64' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'BatchApproval',
    message: {
      roomId: journal.roomId,
      batchIndex: journal.batchIndex,
      journalHash,
      approverRoot: journal.preApproverRoot,
      approverEpoch: journal.preApproverEpoch,
      nonce: 0n,
      deadline,
    },
  })
  const roomSeal = toHex(Buffer.from(roomProof.ethereumSealB64, 'base64'))
  if (
    roomRequest.roomWitness.approver_changes.length !== 0 ||
    roomRequest.roomWitness.admissions.length !== 0 ||
    roomRequest.roomWitness.forced_transactions.length !== 0
  ) {
    throw new Error('this acceptance runner requires an empty control queue fixture')
  }
  const liabilities = roomRequest.roomWitness.post_liabilities.map((raw) => {
    const liability = raw as Record<string, string>
    return {
      asset: liability.asset as Hex,
      pending: BigInt(liability.pending),
      controlled: BigInt(liability.controlled),
      claimable: BigInt(liability.claimable),
      paid: BigInt(liability.paid),
    }
  })
  progress('Submitting the proved batch to the L1 room manager.')
  const submitHash = await wallet.writeContract({
    address: manager,
    abi: managerAbi,
    functionName: 'submitBatch',
    chain: null,
    args: [
      journal.roomId,
      {
        journal,
        seal: roomSeal,
        canonicalBatchData: roomRequest.roomWitness.canonical_batch_data,
        approvals:
          journal.authorizationMode === 0
            ? [
                {
                  index: approval.index,
                  joinedEpoch: approval.joinedEpoch,
                  nonce: 0n,
                  deadline,
                  member: member.address,
                  proof: approval.proof,
                  signature,
                },
              ]
            : [],
        approverChanges: [],
        admissions: [],
        forcedOutcomes: [],
        liabilities,
      },
    ],
    // Groth16 verification contains calls whose EIP-150 forwarding makes a
    // bare preflight estimate too tight on the local Osaka chain. The ceiling
    // scales with the approver count, so an exhausted limit is reported apart
    // from a proof or state revert.
    gas: SUBMIT_GAS_LIMIT,
  })
  const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash })
  if (submitReceipt.status !== 'success') {
    throw new Error(
      submitReceipt.gasUsed >= SUBMIT_GAS_LIMIT
        ? `the proved room submission exhausted its ${SUBMIT_GAS_LIMIT} gas ceiling; raise it for a wider approver set`
        : 'the proved room submission reverted',
    )
  }
  // Every component of `IRoomManager.Room` is named, so viem decodes the
  // output as an object; reading it by field is immune to a reordering of the
  // struct that index-based access would silently misread.
  const room = (await publicClient.readContract({
    address: manager,
    abi: managerAbi,
    functionName: 'roomState',
    args: [journal.roomId],
  })) as { batchIndex: bigint; l2BlockHeight: bigint; stateRoot: Hex }
  if (
    room.batchIndex !== journal.batchIndex ||
    room.l2BlockHeight !== journal.endL2Block ||
    room.stateRoot.toLowerCase() !== journal.postStateRoot.toLowerCase()
  ) {
    throw new Error('the L1 RoomManager state does not match the proved terminal state')
  }

  return { submitReceipt, room }
}
