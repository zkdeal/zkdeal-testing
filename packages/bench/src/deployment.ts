import { toHex, zeroAddress, type Abi, type Hex } from 'viem'
import { artifact } from './artifacts.ts'
import { chainOps, roleId, timelockRunner, type ChainContext } from './chain-ops.ts'
import { runtimeCodeSizeProblem } from './evidence.ts'
import type { ContractJournal } from './journal.ts'
import type { ProofResult } from './prover-client.ts'

/// Bringing the contract set up on the Kurtosis L1: the router and its five
/// facets, the timelock that owns every administrative role, the pool, the
/// token, and the cold template the proved batch builds on.

const CONTROL_ROOT =
  '0xa54dc85ac99f851c92d7c96d7318af41dbe7c0194edfcc37eb4d422a998c1f56' as Hex
const BN254_CONTROL_ID =
  '0x04446e66d300eb7fb45c9726bb53c793dda407a62e9601618bb43c5c14657ac0' as Hex

/// The router, its facets and the interface, loaded and size-checked before
/// a single GPU second is spent. Every other deployed artifact is checked
/// inside `deploy()`.
export async function loadManagerModules() {
  const managerArtifact = await artifact('web3-protocol/contracts/out/RoomManager.sol/RoomManager.json')
  const managerInterfaceArtifact = await artifact(
    'web3-protocol/contracts/out/IRoomManager.sol/IRoomManager.json',
  )
  const intakeFacetArtifact = await artifact(
    'web3-protocol/contracts/out/RoomManagerIntakeFacet.sol/RoomManagerIntakeFacet.json',
  )
  const importFacetArtifact = await artifact(
    'web3-protocol/contracts/out/RoomManagerImportFacet.sol/RoomManagerImportFacet.json',
  )
  const batchFacetArtifact = await artifact(
    'web3-protocol/contracts/out/RoomManagerBatchFacet.sol/RoomManagerBatchFacet.json',
  )
  const validationFacetArtifact = await artifact(
    'web3-protocol/contracts/out/RoomManagerValidationFacet.sol/RoomManagerValidationFacet.json',
  )
  const observationFacetArtifact = await artifact(
    'web3-protocol/contracts/out/RoomManagerObservationFacet.sol/RoomManagerObservationFacet.json',
  )
  const managerModules = [
    managerArtifact,
    intakeFacetArtifact,
    importFacetArtifact,
    batchFacetArtifact,
    validationFacetArtifact,
    observationFacetArtifact,
  ]
  for (const module of managerModules) {
    const problem = runtimeCodeSizeProblem(module)
    if (problem) throw new Error(problem)
  }
  const managerAbi = [...managerArtifact.abi, ...managerInterfaceArtifact.abi] as Abi
  return {
    managerArtifact,
    managerInterfaceArtifact,
    intakeFacetArtifact,
    importFacetArtifact,
    batchFacetArtifact,
    validationFacetArtifact,
    observationFacetArtifact,
    managerAbi,
  }
}

export type ManagerModules = Awaited<ReturnType<typeof loadManagerModules>>

export async function deployStack(
  chain: ChainContext,
  modules: ManagerModules,
  journal: ContractJournal,
  coldProof: ProofResult,
) {
  const { accounts, wallets } = chain
  const {
    managerArtifact,
    intakeFacetArtifact,
    importFacetArtifact,
    batchFacetArtifact,
    validationFacetArtifact,
    observationFacetArtifact,
    managerAbi,
  } = modules

  const upstreamArtifact = await artifact(
    'web3-protocol/contracts/out/RiscZeroGroth16Verifier.sol/RiscZeroGroth16Verifier.json',
  )
  const adapterArtifact = await artifact(
    'web3-protocol/contracts/out/RiscZeroRoomProofVerifier.sol/RiscZeroRoomProofVerifier.json',
  )
  const registryArtifact = await artifact(
    'web3-protocol/contracts/out/ColdTemplateRegistry.sol/ColdTemplateRegistry.json',
  )
  const vaultArtifact = await artifact('web3-protocol/contracts/out/RoomVault.sol/RoomVault.json')
  const tokenArtifact = await artifact(
    'web3-protocol/contracts/out/ZkdealAccessToken.sol/ZkdealAccessToken.json',
  )
  const poolArtifact = await artifact(
    'web3-protocol/contracts/out/RoomPoolManager.sol/RoomPoolManager.json',
  )
  // The acceptance network is an ephemeral chain that cannot wait out the
  // protocol timelock's enforced 48-hour Stage-1 floor. Use the same explicit
  // dev-rig escape as Deploy.s.sol: a stock OpenZeppelin timelock with a zero
  // delay, so schedule/execute and role separation are still exercised without
  // weakening ZkdealTimelock itself. Never let this path target another chain.
  if (chain.chainId !== 31337) {
    throw new Error('the zero-delay acceptance timelock is restricted to chain 31337')
  }
  const timelockArtifact = await artifact(
    'web3-protocol/contracts/out/TimelockController.sol/TimelockController.json',
  )
  const proxyArtifact = await artifact(
    'web3-protocol/contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json',
  )

  const ops = chainOps(chain, proxyArtifact)
  const { deploy, deployProxy, sent, facetCut } = ops

  const upstream = await deploy(upstreamArtifact, [CONTROL_ROOT, BN254_CONTROL_ID])
  const adapter = await deploy(adapterArtifact, [upstream])
  const intakeFacet = await deploy(intakeFacetArtifact)
  const importFacet = await deploy(importFacetArtifact)
  const batchFacet = await deploy(batchFacetArtifact)
  const validationFacet = await deploy(validationFacetArtifact)
  const observationFacet = await deploy(observationFacetArtifact)
  const managerCuts = [
    await facetCut(intakeFacet, intakeFacetArtifact),
    await facetCut(importFacet, importFacetArtifact),
    await facetCut(batchFacet, batchFacetArtifact),
    await facetCut(validationFacet, validationFacetArtifact),
    await facetCut(observationFacet, observationFacetArtifact),
  ]
  const timelock = await deploy(timelockArtifact, [
    0n,
    [accounts.governance.address],
    [zeroAddress],
    zeroAddress,
  ])
  const registry = await deployProxy(registryArtifact, [
    timelock,
    accounts.templateAdmin.address,
  ])
  const vault = await deployProxy(vaultArtifact, [timelock])
  const manager = await deployProxy(managerArtifact, [
    registry,
    vault,
    journal.deploymentDomain,
    timelock,
    managerCuts,
    // DeploymentProfile.OPEN: this stand exercises unanimous and validity
    // rooms alike, so the deploy-time immutable profile stays unrestricted.
    0,
  ])
  const token = await deployProxy(tokenArtifact, [accounts.treasury.address, timelock])
  const pool = await deployProxy(poolArtifact, [
    token,
    manager,
    registry,
    accounts.treasury.address,
    timelock,
    accounts.controller.address,
    accounts.guardian.address,
  ])

  const throughTimelock = timelockRunner(
    ops,
    wallets.governance,
    timelock,
    timelockArtifact.abi,
  )

  await throughTimelock(
    vault,
    vaultArtifact.abi,
    'grantRole',
    [roleId('MANAGER_ROLE'), manager],
    'vault-manager',
  )
  await throughTimelock(
    manager,
    managerAbi,
    'grantRole',
    [roleId('SERVICE_MANAGER_ROLE'), pool],
    'managed-room-service',
  )
  await throughTimelock(
    pool,
    poolArtifact.abi,
    'grantRole',
    [roleId('NODE_ADMIN_ROLE'), accounts.nodeAdmin.address],
    'node-admin',
  )
  await throughTimelock(
    pool,
    poolArtifact.abi,
    'grantRole',
    [roleId('TEMPLATE_ADMIN_ROLE'), accounts.templateAdmin.address],
    'template-admin',
  )

  // `register` validates a template by calling the verifier being registered, so
  // ColdTemplateRegistry keeps an allowlist governed by VERIFIER_ADMIN_ROLE - held
  // by the timelock, not the template admin. Without this the register below
  // reverts InvalidTemplate() after the CUDA cold proof has already been paid for.
  await throughTimelock(
    registry,
    registryArtifact.abi,
    'setVerifierAllowed',
    [adapter, true],
    'cold-template-verifier',
  )

  // The protocol flow fee: 100 bps (the contract-constant ceiling) accruing to
  // the treasury role account. The example runner queues a real deposit and
  // asserts the skim landed, so a stand that forgot this wiring fails its
  // evidence gate rather than silently running fee-free.
  await throughTimelock(
    manager,
    managerAbi,
    'setProtocolFee',
    [100, accounts.treasury.address],
    'protocol-fee',
  )
  await throughTimelock(
    manager,
    managerAbi,
    'grantRole',
    [roleId('TREASURY_ROLE'), accounts.treasury.address],
    'protocol-treasury',
  )

  const coldSeal = toHex(Buffer.from(coldProof.ethereumSealB64, 'base64'))
  // The v6 registry statement binds keccak256 of the framed canonical cold
  // witness. The prover commits that digest inside the cold proof reply, so a
  // reply without one cannot register a template at all.
  if (!coldProof.genesisDataHash) {
    throw new Error('the cold proof omitted the genesis data hash the registry statement binds')
  }
  const registerReceipt = await sent(
    wallets.templateAdmin,
    registry,
    registryArtifact.abi,
    'register',
    [
      journal.coldTemplateId,
      journal.preStateRoot,
      journal.policyHash,
      journal.proofProgramId,
      journal.proofSystemVersion,
      coldProof.genesisDataHash,
      adapter,
      coldSeal,
    ],
  )
  // VALIDITY_ONLY rooms require the template's one-way seal-free exit-route
  // attestation; bind it right after registration, still as the template admin.
  await sent(
    wallets.templateAdmin,
    registry,
    registryArtifact.abi,
    'bindExitRoute',
    [journal.coldTemplateId],
  )

  return {
    ops,
    throughTimelock,
    managerAbi,
    intakeFacetArtifact,
    tokenArtifact,
    poolArtifact,
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
    registerReceipt,
  }
}

export type DeployedStack = Awaited<ReturnType<typeof deployStack>>
