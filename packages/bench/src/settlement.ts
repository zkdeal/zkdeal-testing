import { keccak256, parseEther, toBytes, zeroHash, type Abi, type Hex } from 'viem'
import {
  DEFAULT_ADMIN_ROLE,
  expectState,
  roleId,
  type ChainContext,
} from './chain-ops.ts'
import type { DeployedStack } from './deployment.ts'
import {
  ALLOCATION_DISPOSED,
  NODE_DEGRADED,
  NODE_READY,
  nodeId,
  slotId,
  type AllocationState,
  type PoolStateReader,
} from './pool-lifecycle.ts'
import { progress } from './runner-env.ts'

/// What the run does after the proved batch is accepted: drain the allocation,
/// check that every claim moves the tokens it says it does, and read back both
/// halves of role separation.

export async function drainManagedAllocation(
  chain: ChainContext,
  deployed: DeployedStack,
  reader: PoolStateReader,
  allocationId: Hex,
  deadlineBlocksFromStart: bigint,
) {
  const { accounts, publicClient, wallets } = chain
  const { pool, poolArtifact, token, tokenArtifact } = deployed
  const { sent } = deployed.ops
  const { poolRead, readNode } = reader

  progress('Draining the managed allocation and checking the pool accounting.')
  await sent(
    wallets.service,
    pool,
    poolArtifact.abi,
    'reportNodeHeartbeat',
    [nodeId, zeroHash],
  )
  await sent(wallets.guardian, pool, poolArtifact.abi, 'quarantineNode', [nodeId])
  expectState('the post-submission quarantine', (await readNode()).status, NODE_DEGRADED)
  const managedAllocation = await poolRead<AllocationState>('allocationState', [allocationId])
  const { startBlock, proofDeadlineBlock } = managedAllocation
  if (proofDeadlineBlock !== startBlock + deadlineBlocksFromStart) {
    throw new Error('the managed proof deadline does not equal room start plus the chosen blocks')
  }
  const tokenBalance = (account: Hex) =>
    publicClient.readContract({
      address: token,
      abi: tokenArtifact.abi,
      functionName: 'balanceOf',
      args: [account],
    }) as Promise<bigint>
  await sent(
    wallets.customer,
    pool,
    poolArtifact.abi,
    'disposeRoom',
    [allocationId],
  )
  const disposedAllocation = await poolRead<AllocationState>('allocationState', [allocationId])
  expectState('disposeRoom', disposedAllocation.status, ALLOCATION_DISPOSED)
  expectState('disposeRoom', disposedAllocation.runningEscrow, 0n)
  expectState('disposeRoom', (await readNode()).activeAllocations, 0n)

  // The claims have to move tokens, not merely succeed.
  const serviceBalanceBeforeClaim = await tokenBalance(accounts.service.address)
  const serviceClaimable = await poolRead<bigint>('claimableServiceFees', [
    accounts.service.address,
  ])
  await sent(wallets.service, pool, poolArtifact.abi, 'claimServiceFees')
  expectState(
    'claimServiceFees',
    await tokenBalance(accounts.service.address),
    serviceBalanceBeforeClaim + serviceClaimable,
  )
  expectState(
    'claimServiceFees',
    await poolRead<bigint>('claimableServiceFees', [accounts.service.address]),
    0n,
  )
  const treasuryBalanceBeforeClaim = await tokenBalance(accounts.treasury.address)
  const treasuryClaimable = await poolRead<bigint>('totalTreasuryClaimable')
  await sent(wallets.treasury, pool, poolArtifact.abi, 'claimTreasuryFees')
  expectState(
    'claimTreasuryFees',
    await tokenBalance(accounts.treasury.address),
    treasuryBalanceBeforeClaim + treasuryClaimable,
  )
  expectState('claimTreasuryFees', await poolRead<bigint>('totalTreasuryClaimable'), 0n)
  await publicClient.readContract({
    address: pool,
    abi: poolArtifact.abi,
    functionName: 'assertEscrowSolvent',
  })

  return { startBlock, proofDeadlineBlock }
}

/// The acceptance run deliberately exercises quarantine and disposal. Recover
/// from that canary before publishing the stand so the managed-room profile is
/// backed by live capacity and a price epoch that remains usable between
/// deployments.
export async function restoreManagedPoolAvailability(
  chain: ChainContext,
  deployed: DeployedStack,
  reader: PoolStateReader,
) {
  const { publicClient, wallets } = chain
  const { pool, poolArtifact } = deployed
  const { sent } = deployed.ops
  const { poolRead, readNode, readSlot } = reader
  const readyProfile = keccak256(toBytes('managed-stand-ready-profile'))

  progress('Restoring managed-room capacity after the acceptance canary.')
  await sent(
    wallets.service,
    pool,
    poolArtifact.abi,
    'reportNodeHeartbeat',
    [nodeId, readyProfile],
  )
  await sent(
    wallets.controller,
    pool,
    poolArtifact.abi,
    'confirmCapacityProfile',
    [nodeId, readyProfile, [slotId], [1]],
  )
  expectState('managed-room node recovery', (await readNode()).status, NODE_READY)
  expectState('managed-room ready capacity', (await readSlot()).readySlots, 1)

  const previousPrice = await poolRead<readonly bigint[]>('prices', [nodeId, slotId])
  const validUntilBlock = BigInt(await publicClient.getBlockNumber()) + 31_536_000n
  await sent(
    wallets.service,
    pool,
    poolArtifact.abi,
    'publishPriceEpoch',
    [
      nodeId,
      slotId,
      validUntilBlock,
      parseEther('10'),
      parseEther('2'),
      parseEther('0.1'),
      parseEther('0.01'),
    ],
  )
  const publicPrice = await poolRead<readonly bigint[]>('prices', [nodeId, slotId])
  expectState('managed-room price epoch', publicPrice[0], previousPrice[0] + 1n)
  expectState('managed-room price validity', publicPrice[1], validUntilBlock)

  return { publicPrice }
}

export async function readRoleSeparation(chain: ChainContext, deployed: DeployedStack) {
  const { accounts, deployer, publicClient } = chain
  const { manager, managerAbi, pool, poolArtifact, timelock } = deployed

  const roleChecks = {
    upgradeTimelock: await publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'hasRole',
      args: [roleId('UPGRADER_ROLE'), timelock],
    }),
    nodeAdmin: await publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'hasRole',
      args: [roleId('NODE_ADMIN_ROLE'), accounts.nodeAdmin.address],
    }),
    templateAdmin: await publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'hasRole',
      args: [roleId('TEMPLATE_ADMIN_ROLE'), accounts.templateAdmin.address],
    }),
    controller: await publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'hasRole',
      args: [roleId('POOL_CONTROLLER_ROLE'), accounts.controller.address],
    }),
    guardianMonitor: await publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'hasRole',
      args: [roleId('MONITOR_ROLE'), accounts.guardian.address],
    }),
    guardianPauser: await publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'hasRole',
      args: [roleId('PAUSER_ROLE'), accounts.guardian.address],
    }),
    treasury: await publicClient.readContract({
      address: pool,
      abi: poolArtifact.abi,
      functionName: 'hasRole',
      args: [roleId('TREASURY_ROLE'), accounts.treasury.address],
    }),
    serviceManager: await publicClient.readContract({
      address: manager,
      abi: managerAbi,
      functionName: 'hasRole',
      args: [roleId('SERVICE_MANAGER_ROLE'), pool],
    }),
  }
  if (Object.values(roleChecks).some((value) => value !== true)) {
    throw new Error('one or more governance or service roles were not assigned as intended')
  }

  // Roles held by the intended accounts is only half of role separation. The
  // deploying key funds and creates everything, so the artifact also has to
  // show it kept no administrative or upgrade power over either contract.
  const holdsRole = (address: Hex, abi: Abi, role: Hex, holder: Hex) =>
    publicClient.readContract({
      address,
      abi,
      functionName: 'hasRole',
      args: [role, holder],
    }) as Promise<boolean>
  const roleDenials = {
    poolAdminDeployer: await holdsRole(pool, poolArtifact.abi, DEFAULT_ADMIN_ROLE, deployer.address),
    poolUpgraderDeployer: await holdsRole(
      pool,
      poolArtifact.abi,
      roleId('UPGRADER_ROLE'),
      deployer.address,
    ),
    managerAdminDeployer: await holdsRole(manager, managerAbi, DEFAULT_ADMIN_ROLE, deployer.address),
    managerUpgraderDeployer: await holdsRole(
      manager,
      managerAbi,
      roleId('UPGRADER_ROLE'),
      deployer.address,
    ),
    poolAdminCustomer: await holdsRole(
      pool,
      poolArtifact.abi,
      DEFAULT_ADMIN_ROLE,
      accounts.customer.address,
    ),
    poolUpgraderNodeAdmin: await holdsRole(
      pool,
      poolArtifact.abi,
      roleId('UPGRADER_ROLE'),
      accounts.nodeAdmin.address,
    ),
  }
  if (Object.values(roleDenials).some((value) => value !== false)) {
    throw new Error('an account that must hold no administrative power over the deployment in fact holds it')
  }

  return { roleChecks, roleDenials }
}
