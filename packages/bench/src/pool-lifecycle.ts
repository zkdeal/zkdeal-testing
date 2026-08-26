import { keccak256, parseEther, toBytes, zeroAddress, zeroHash, type Hex } from 'viem'
import { expectRevert, expectState, type ChainContext } from './chain-ops.ts'
import type { DeployedStack } from './deployment.ts'
import { jsonSafe, type GpuCalibration } from './evidence.ts'
import type { ContractJournal } from './journal.ts'

/// The pool the acceptance run configures and drives: its identifiers, the
/// state shapes it reads back after every transition, and the two phases that
/// bring one node and one slot to READY and then prove the proxy upgrade
/// preserves storage.

export const presetId = keccak256(toBytes('kurtosis-v6-preset'))
export const nodeId = keccak256(toBytes('kurtosis-4090-node'))
export const slotId = keccak256(toBytes('exact-block-deadline-slot'))
const profileHash = keccak256(toBytes('one-fast-slot-profile'))
export const NODE_READY = 2
export const NODE_DEGRADED = 4
export const ALLOCATION_USED = 2
export const ALLOCATION_DISPOSED = 3
// ERC-1967 implementation slot, read directly so an upgrade is confirmed by
// the proxy rather than by the transaction having succeeded.
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex

export type NodeState = {
  serviceAccount: Hex
  boundAccount: Hex
  metadataHash: Hex
  pendingProfileHash: Hex
  status: number
  heartbeatTimeoutBlocks: bigint
  lastHealthyBlock: bigint
  profileNonce: bigint
  activeAllocations: bigint
}
export type SlotState = {
  presetId: Hex
  minDeadlineBlocks: bigint
  maxDeadlineBlocks: bigint
  localProofTargetSeconds: bigint
  capacityCap: number
  readySlots: number
  exists: boolean
}
export type AllocationState = {
  user: Hex
  status: number
  startBlock: bigint
  proofDeadlineBlock: bigint
  deadlineBlocksFromStart: bigint
  priceEpoch: bigint
  roomId: bigint
  runningEscrow: bigint
}

export function poolStateReader(chain: ChainContext, deployed: DeployedStack) {
  const { publicClient } = chain
  const { pool, poolArtifact } = deployed
  const poolRead = <T>(functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName,
      args,
    }) as Promise<T>
  const readNode = () => poolRead<NodeState>('nodeState', [nodeId])
  const readSlot = () => poolRead<SlotState>('slotState', [nodeId, slotId])
  return { poolRead, readNode, readSlot }
}

export type PoolStateReader = ReturnType<typeof poolStateReader>

/// Register the preset and the node, advertise a slot sized from the measured
/// GPU, and walk the node through capacity, pause, quarantine, recovery and a
/// price epoch, reading back the state each call claims to have changed.
export async function configurePool(
  chain: ChainContext,
  deployed: DeployedStack,
  reader: PoolStateReader,
  journal: ContractJournal,
  calibration: GpuCalibration,
) {
  const { accounts, publicClient, wallets } = chain
  const { pool, poolArtifact } = deployed
  const { sent } = deployed.ops
  const { poolRead, readNode, readSlot } = reader

  await sent(
    wallets.templateAdmin,
    pool,
    poolArtifact.abi,
    'registerPreset',
    [presetId, journal.coldTemplateId, journal.policyHash],
  )
  await sent(
    wallets.nodeAdmin,
    pool,
    poolArtifact.abi,
    'registerNode',
    [
      nodeId,
      accounts.service.address,
      zeroAddress,
      keccak256(toBytes('kurtosis-node-metadata')),
      20n,
    ],
  )
  // The slot advertises what this GPU actually delivered plus the stated
  // margin, not a constant chosen before the measurement. Both the raw
  // recommendation and the applied value reach the evidence file.
  const MINIMUM_DEADLINE_BLOCKS = 1n
  const MAXIMUM_DEADLINE_BLOCKS = 7_200n
  const localProofTargetSeconds = BigInt(calibration.recommendedProofSeconds)
  const deadlineBlocksFromStart = BigInt(calibration.recommendedDeadlineBlocks)
  if (
    deadlineBlocksFromStart < MINIMUM_DEADLINE_BLOCKS ||
    deadlineBlocksFromStart > MAXIMUM_DEADLINE_BLOCKS
  ) {
    throw new Error('the measured proof time recommends a deadline this slot cannot advertise')
  }
  await sent(
    wallets.nodeAdmin,
    pool,
    poolArtifact.abi,
    'configureSlot',
    [
      nodeId,
      slotId,
      presetId,
      MINIMUM_DEADLINE_BLOCKS,
      MAXIMUM_DEADLINE_BLOCKS,
      localProofTargetSeconds,
      1,
    ],
  )
  expectState(
    'configureSlot',
    (await readSlot()).localProofTargetSeconds,
    localProofTargetSeconds,
  )
  await sent(
    wallets.controller,
    pool,
    poolArtifact.abi,
    'requestCapacityProfile',
    [nodeId, profileHash],
  )
  await sent(
    wallets.controller,
    pool,
    poolArtifact.abi,
    'confirmCapacityProfile',
    [nodeId, profileHash, [slotId], [1]],
  )
  expectState('confirmCapacityProfile', (await readNode()).status, NODE_READY)
  expectState('confirmCapacityProfile', (await readSlot()).readySlots, 1)
  await sent(wallets.guardian, pool, poolArtifact.abi, 'pause')
  expectState('pause', await poolRead<boolean>('paused'), true)
  // Pausing has to close a gated entry point, not merely flip a flag.
  await expectRevert('a paused reservation', 'EnforcedPause', () =>
    publicClient.simulateContract({
      account: accounts.customer,
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'reserveRoomWithPermit',
      args: [
        {
          nodeId,
          slotId,
          presetId,
          deadlineBlocksFromStart: 1n,
          priceEpoch: 1n,
          maxTokenCharge: 0n,
        },
        { value: 0n, deadline: 0n, v: 27, r: zeroHash, s: zeroHash },
      ],
    }),
  )
  await sent(wallets.guardian, pool, poolArtifact.abi, 'unpause')
  expectState('unpause', await poolRead<boolean>('paused'), false)
  await sent(wallets.guardian, pool, poolArtifact.abi, 'quarantineNode', [nodeId])
  expectState('quarantineNode', (await readNode()).status, NODE_DEGRADED)
  const recoveredProfile = keccak256(toBytes('recovered-one-fast-slot-profile'))
  await sent(
    wallets.service,
    pool,
    poolArtifact.abi,
    'reportNodeHeartbeat',
    [nodeId, recoveredProfile],
  )
  expectState('reportNodeHeartbeat', (await readNode()).pendingProfileHash, recoveredProfile)
  await sent(
    wallets.controller,
    pool,
    poolArtifact.abi,
    'confirmCapacityProfile',
    [nodeId, recoveredProfile, [slotId], [1]],
  )
  expectState('the quarantine recovery', (await readNode()).status, NODE_READY)
  const priceValidUntilBlock = BigInt(await publicClient.getBlockNumber()) + 1_000n
  await sent(
    wallets.service,
    pool,
    poolArtifact.abi,
    'publishPriceEpoch',
    [
      nodeId,
      slotId,
      priceValidUntilBlock,
      parseEther('10'),
      parseEther('2'),
      parseEther('0.1'),
      parseEther('0.01'),
    ],
  )
  const publishedPrice = await poolRead<readonly bigint[]>('prices', [nodeId, slotId])
  expectState('publishPriceEpoch', publishedPrice[0], 1n)
  expectState('publishPriceEpoch', publishedPrice[1], priceValidUntilBlock)
  expectState('publishPriceEpoch', publishedPrice[2], parseEther('10'))

  return { localProofTargetSeconds, deadlineBlocksFromStart, publishedPrice }
}

/// A storage-preserving upgrade has to be demonstrated, not asserted: capture
/// the pool's observable state, confirm the proxy really moved to a new
/// implementation, then require every captured value to be unchanged.
export async function proveStoragePreservingUpgrade(
  chain: ChainContext,
  deployed: DeployedStack,
  reader: PoolStateReader,
  publishedPrice: readonly bigint[],
): Promise<void> {
  const { publicClient } = chain
  const { pool, poolArtifact, throughTimelock } = deployed
  const { deploy } = deployed.ops
  const { poolRead, readNode, readSlot } = reader

  const nodeBeforeUpgrade = JSON.stringify(jsonSafe(await readNode()))
  const slotBeforeUpgrade = JSON.stringify(jsonSafe(await readSlot()))
  const priceBeforeUpgrade = JSON.stringify(jsonSafe(publishedPrice))
  const escrowBeforeUpgrade = JSON.stringify(
    jsonSafe([
      await poolRead<bigint>('totalUserEscrow'),
      await poolRead<bigint>('totalServiceClaimable'),
      await poolRead<bigint>('totalTreasuryClaimable'),
    ]),
  )
  const implementationBeforeUpgrade = await publicClient.getStorageAt({
    address: pool,
    slot: IMPLEMENTATION_SLOT,
  })
  const replacementPoolImplementation = await deploy(poolArtifact)
  await throughTimelock(
    pool,
    poolArtifact.abi,
    'upgradeToAndCall',
    [replacementPoolImplementation, '0x'],
    'room-pool-storage-preserving-upgrade',
  )
  const implementationAfterUpgrade = await publicClient.getStorageAt({
    address: pool,
    slot: IMPLEMENTATION_SLOT,
  })
  if (
    !implementationAfterUpgrade ||
    implementationAfterUpgrade === implementationBeforeUpgrade ||
    !implementationAfterUpgrade
      .toLowerCase()
      .endsWith(replacementPoolImplementation.slice(2).toLowerCase())
  ) {
    throw new Error('the room pool proxy did not adopt the replacement implementation')
  }
  expectState('the pool upgrade', JSON.stringify(jsonSafe(await readNode())), nodeBeforeUpgrade)
  expectState('the pool upgrade', JSON.stringify(jsonSafe(await readSlot())), slotBeforeUpgrade)
  expectState(
    'the pool upgrade',
    JSON.stringify(jsonSafe(await poolRead<readonly bigint[]>('prices', [nodeId, slotId]))),
    priceBeforeUpgrade,
  )
  expectState(
    'the pool upgrade',
    JSON.stringify(
      jsonSafe([
        await poolRead<bigint>('totalUserEscrow'),
        await poolRead<bigint>('totalServiceClaimable'),
        await poolRead<bigint>('totalTreasuryClaimable'),
      ]),
    ),
    escrowBeforeUpgrade,
  )
}
