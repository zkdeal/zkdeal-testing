import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  toBytes,
  zeroHash,
  type Abi,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Artifact } from './artifacts.ts'
import { runtimeCodeSizeProblem } from './evidence.ts'

/// The chain-side plumbing of the acceptance run: the role accounts it funds,
/// the deployment and transaction helpers every phase shares, and the two
/// assertions that turn a successful receipt into a claim about state.

const DEFAULT_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const MEMBER_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
const roleKey = (role: string) => keccak256(toBytes(`zkdeal/kurtosis/role/${role}`)) as Hex
const ROLE_KEYS = {
  governance: roleKey('governance'),
  nodeAdmin: roleKey('node-admin'),
  templateAdmin: roleKey('template-admin'),
  controller: roleKey('pool-controller'),
  guardian: roleKey('guardian'),
  service: roleKey('node-service'),
  treasury: roleKey('treasury'),
  customer: roleKey('customer'),
} as const

export const roleId = (name: string) => keccak256(toBytes(name))
/// OpenZeppelin's `DEFAULT_ADMIN_ROLE` is the zero word, not a hashed name.
export const DEFAULT_ADMIN_ROLE = zeroHash

/// The client types are written out rather than inferred: an inferred viem
/// client cannot be named across a module boundary (TS2742).
export type RunnerPublicClient = PublicClient<HttpTransport, undefined>
export type RunnerWalletClient = WalletClient<HttpTransport, undefined, PrivateKeyAccount>

export type ChainContext = {
  deployer: PrivateKeyAccount
  member: PrivateKeyAccount
  publicClient: RunnerPublicClient
  wallet: RunnerWalletClient
  chainId: number
  accounts: Record<keyof typeof ROLE_KEYS, PrivateKeyAccount>
  wallets: Record<keyof typeof ROLE_KEYS, RunnerWalletClient>
}

const TRANSACTION_INDEXING_RETRY_MS = 250
const TRANSACTION_INDEXING_TIMEOUT_MS = 60_000

async function waitForIndexedTransactionReceipt(
  publicClient: RunnerPublicClient,
  hash: Hex,
) {
  const deadline = Date.now() + TRANSACTION_INDEXING_TIMEOUT_MS
  for (;;) {
    try {
      return await publicClient.waitForTransactionReceipt({ hash })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('transaction indexing is in progress') || Date.now() >= deadline) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, TRANSACTION_INDEXING_RETRY_MS))
    }
  }
}

/// The deployer, the batch approver and one wallet per Kurtosis role, all bound
/// to the same enclave L1.
export async function connectChain(rpcUrl: string): Promise<ChainContext> {
  const deployer = privateKeyToAccount((process.env.DEPLOYER_KEY as Hex | undefined) ?? DEFAULT_KEY)
  const member = privateKeyToAccount(MEMBER_KEY)
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const wallet = createWalletClient({ account: deployer, transport: http(rpcUrl) })
  const chainId = await publicClient.getChainId()
  const accounts = Object.fromEntries(
    Object.entries(ROLE_KEYS).map(([name, key]) => [name, privateKeyToAccount(key)]),
  ) as Record<keyof typeof ROLE_KEYS, PrivateKeyAccount>
  const wallets = Object.fromEntries(
    Object.entries(accounts).map(([name, account]) => [
      name,
      createWalletClient({ account, transport: http(rpcUrl) }),
    ]),
  ) as Record<keyof typeof ROLE_KEYS, RunnerWalletClient>
  return { deployer, member, publicClient, wallet, chainId, accounts, wallets }
}

export async function fundRoleAccounts(chain: ChainContext): Promise<void> {
  const { publicClient, wallet, deployer, accounts } = chain
  // The eight funding transfers share one sender and consecutive nonces and
  // depend on nothing but each other, so only the last receipt is awaited: its
  // inclusion implies every earlier nonce was mined. On a twelve-second devnet
  // that is seven fewer blocks of the enclave budget spent on setup.
  let fundingNonce = await publicClient.getTransactionCount({ address: deployer.address })
  let lastFundingHash: Hex | undefined
  for (const account of Object.values(accounts)) {
    lastFundingHash = await wallet.sendTransaction({
      account: deployer,
      chain: null,
      to: account.address,
      value: parseEther('1'),
      nonce: fundingNonce,
    })
    fundingNonce += 1
  }
  if (lastFundingHash) {
    const funded = await waitForIndexedTransactionReceipt(publicClient, lastFundingHash)
    if (funded.status !== 'success') throw new Error('funding the role accounts reverted')
  }
}

/// Deployment and write helpers bound to one chain and one proxy artifact. Every
/// phase of the run shares this one instance so a failure names the contract or
/// the entry point rather than surfacing as a viem type error.
export function chainOps(chain: ChainContext, proxyArtifact: Artifact) {
  const { publicClient, wallet } = chain

  async function deploy(contract: Artifact, args: readonly unknown[] = []): Promise<Hex> {
    const problem = runtimeCodeSizeProblem(contract)
    if (problem) throw new Error(problem)
    const hash = await wallet.deployContract({
      abi: contract.abi,
      bytecode: contract.bytecode.object,
      args,
      chain: null,
    })
    // A reverted or out-of-gas deployment returns a null address that the run
    // would otherwise carry into the next call as a viem type error naming
    // neither the contract nor the deployment.
    const receipt = await waitForIndexedTransactionReceipt(publicClient, hash)
    if (receipt.status !== 'success') throw new Error(`deploying ${contract.source} reverted`)
    if (!receipt.contractAddress) {
      throw new Error(`deploying ${contract.source} produced no contract address`)
    }
    return receipt.contractAddress
  }

  async function deployProxy(
    contract: Artifact,
    initializeArgs: readonly unknown[],
  ): Promise<Hex> {
    const implementation = await deploy(contract)
    const initializer = encodeFunctionData({
      abi: contract.abi,
      functionName: 'initialize',
      args: initializeArgs,
    })
    return deploy(proxyArtifact, [implementation, initializer])
  }

  async function sent(
    roleWallet: RunnerWalletClient,
    address: Hex,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
  ) {
    const hash = await roleWallet.writeContract({
      account: roleWallet.account!,
      address,
      abi,
      functionName,
      args,
      chain: null,
    })
    const receipt = await waitForIndexedTransactionReceipt(publicClient, hash)
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`)
    return receipt
  }

  async function facetCut(address: Hex, facetArtifact: Artifact) {
    const selectors = (await publicClient.readContract({
      address,
      abi: facetArtifact.abi,
      functionName: 'selectors',
    })) as readonly Hex[]
    return { facet: address, selectors }
  }

  return { deploy, deployProxy, sent, facetCut }
}

export type ChainOps = ReturnType<typeof chainOps>

/// Governance calls are scheduled and executed through the deployed timelock,
/// which is the only holder of the administrative roles.
export function timelockRunner(
  ops: ChainOps,
  governanceWallet: RunnerWalletClient,
  timelock: Hex,
  timelockAbi: Abi,
) {
  return async function throughTimelock(
    target: Hex,
    targetAbi: Abi,
    functionName: string,
    args: readonly unknown[],
    label: string,
  ): Promise<void> {
    const data = encodeFunctionData({ abi: targetAbi, functionName, args })
    const salt = keccak256(toBytes(`zkdeal/kurtosis/timelock/${label}`))
    await ops.sent(
      governanceWallet,
      timelock,
      timelockAbi,
      'schedule',
      [target, 0n, data, zeroHash, salt, 0n],
    )
    await ops.sent(
      governanceWallet,
      timelock,
      timelockAbi,
      'execute',
      [target, 0n, data, zeroHash, salt],
    )
  }
}

export type TimelockRunner = ReturnType<typeof timelockRunner>

// A successful receipt only says a call did not revert. Every pool transition
// in this run is confirmed by reading the state it claims to have changed.
export function expectState(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `${label} left the pool in an unexpected state: ${String(actual)} instead of ${String(expected)}`,
    )
  }
}

export async function expectRevert(label: string, marker: string, call: () => Promise<unknown>) {
  try {
    await call()
  } catch (error: unknown) {
    const reported = error instanceof Error ? error.message : String(error)
    if (reported.includes(marker)) return
    throw new Error(`${label} reverted, but not with ${marker}`)
  }
  throw new Error(`${label} was expected to revert with ${marker} and did not`)
}
