import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseEther, zeroAddress, type Abi, type Hex } from 'viem'
import { humanText, writeHumanFailure, writeHumanReport } from '../../../scripts/lib/human-report.mts'
import {
  EXAMPLE_CASE_PRESETS,
  EXAMPLE_CASES,
  PROTOCOL_FEE_BPS,
  expectedFeeWei,
  validateExampleEvidence,
} from './example-evidence.ts'
import { artifact } from './artifacts.ts'
import { connectChain, type ChainContext, type RunnerWalletClient } from './chain-ops.ts'
import { jsonSafe } from './evidence.ts'
import { nodeId, type NodeState } from './pool-lifecycle.ts'

/// The per-example acceptance run: drive one case's preset rooms through the
/// RUNNING coordinator's /demo/v1 plane to an L1-accepted checkpoint each,
/// prove the 100 bps protocol flow fee on a real deposit against the deployed
/// RoomManager, and - when the shared prove queue ran - record its liveness and
/// the registered node's on-chain heartbeat. It assumes the bootstrap
/// acceptance already ran in this enclave: the contracts are deployed, the fee
/// is wired, and the role accounts are funded.

const outputPath = process.env.OUT_PATH ?? '/out/example-evidence.json'
const demoUrl = (process.env.DEMO_URL ?? 'http://zkdeal-demo:3000').replace(/\/+$/, '')
const exampleCase = process.env.EXAMPLE_CASE ?? ''
const l1RpcUrl = process.env.L1_RPC_URL
const queueUrl = process.env.QUEUE_URL ? process.env.QUEUE_URL.replace(/\/+$/, '') : undefined
const roomManager = process.env.ROOM_MANAGER as Hex | undefined
const roomPool = process.env.ROOM_POOL as Hex | undefined

// The enclave kills this container at its own `example_timeout` (20m by
// default). Every wait below is carved out of the same budget so the
// structured failure file is always written before Kurtosis reclaims the
// process. Set RUNNER_TIMEOUT_SECONDS whenever the enclave wait changes.
const DEFAULT_RUNNER_BUDGET_SECONDS = 20 * 60
const configuredBudgetSeconds = Number(
  process.env.RUNNER_TIMEOUT_SECONDS ?? DEFAULT_RUNNER_BUDGET_SECONDS,
)
const runnerBudgetSeconds =
  Number.isFinite(configuredBudgetSeconds) && configuredBudgetSeconds > 0
    ? configuredBudgetSeconds
    : DEFAULT_RUNNER_BUDGET_SECONDS
// Nine tenths for the run; the last tenth writes the failure evidence.
const runnerDeadlineMs = Date.now() + runnerBudgetSeconds * 1_000 * 0.9
const remainingBudgetMs = () => Math.max(0, runnerDeadlineMs - Date.now())

const DEMO_REQUEST_TIMEOUT_MS = 60_000
const JOB_POLL_INTERVAL_MS = 2_000
const SYSTEM_READY_TIMEOUT_MS = 3 * 60_000
// The agent's on-chain heartbeat fires every 60 s (prover-node/agent
// heartbeat.ts DEFAULT_ONCHAIN_INTERVAL_MS), so a 60 s window is a coin flip:
// a fast single-preset case can reach this assertion right after a beat and
// miss the whole next one. Cover a full missed interval plus L1 inclusion.
const HEARTBEAT_WINDOW_MS = 150_000
const HEARTBEAT_POLL_INTERVAL_MS = 5_000
const DEPOSIT_WEI = parseEther('0.1')
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/

/** Phases to stderr, redacted; the machine decision on stdout stays one block. */
function progress(phase: string): void {
  process.stderr.write(`Progress: ${humanText(phase)}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ---------- the coordinator's /demo/v1 plane ---------- */

type DemoFailureView = { explanation?: string }
type DemoJobView = {
  id: string
  kind: string
  phase: string
  finishedAt: string | null
  failure?: DemoFailureView
}
type DemoTemplateView = { id: string; phase: string; failure?: DemoFailureView }
type DemoRoomView = {
  id: string
  phase: string
  chainRoomId: string | null
  checkpoint?: { l1TransactionHash: string; l1Block: string; batchIndex: number }
  failure?: DemoFailureView
}
type DemoPresetView = {
  id: string
  actions: Array<{ id: string; actor: string; recommendedBlock: 1 | 2 }>
}
type DemoSystemView = {
  decision: string
  services: Array<{ label: string; status: string }>
}

/** Every run creates fresh rooms: the coordinator's idempotency store outlives
 * this process, so a reused key would silently replay an earlier run's rooms
 * and this run's evidence would describe someone else's checkpoints. */
const runNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const idempotencyKey = (step: string) => `example-${exampleCase}-${runNonce}-${step}`

async function demoRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const budget = remainingBudgetMs()
  if (budget <= 0) {
    throw new Error(`the run exhausted its budget before ${method} ${path}`)
  }
  const headers: Record<string, string> = {}
  let body: string | undefined
  if (method === 'POST') {
    // Fastify refuses an empty body under an application/json content type, so
    // every POST carries at least the empty object.
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body ?? {})
  }
  // The exact header the route reads; see idempotencyKey() in demo-routes.ts.
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
  const response = await fetch(`${demoUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(Math.max(1, Math.min(DEMO_REQUEST_TIMEOUT_MS, budget))),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `the demo coordinator returned HTTP ${response.status} for ${method} ${path} with an unreadable body: ${text.slice(0, 200)}`,
    )
  }
  if (!response.ok) {
    const failure = (parsed as { error?: DemoFailureView | string }).error
    const reason =
      typeof failure === 'string' ? failure : (failure?.explanation ?? text.slice(0, 200))
    throw new Error(`the demo coordinator refused ${method} ${path}: ${reason}`)
  }
  return parsed as T
}

/** Wait for one coordinator job. A FAILED job surfaces its recorded story. */
async function waitForJob(jobId: string, subject: string): Promise<void> {
  for (;;) {
    const job = await demoRequest<DemoJobView>('GET', `/demo/v1/jobs/${jobId}`)
    if (job.phase === 'FAILED') {
      throw new Error(`${subject} failed: ${job.failure?.explanation ?? 'no recorded reason'}`)
    }
    if (job.finishedAt) return
    if (remainingBudgetMs() <= JOB_POLL_INTERVAL_MS) {
      throw new Error(`${subject} did not finish within the runner budget`)
    }
    await sleep(JOB_POLL_INTERVAL_MS)
  }
}

/** The plan already gated on HTTP 200; this run additionally requires READY so
 * a dead prover fails here by name instead of twenty seconds into a proof. */
async function waitForReadySystem(): Promise<void> {
  const deadline = Date.now() + Math.min(SYSTEM_READY_TIMEOUT_MS, remainingBudgetMs())
  let last: DemoSystemView | null = null
  for (;;) {
    last = await demoRequest<DemoSystemView>('GET', '/demo/v1/system')
    if (last.decision === 'READY') return
    if (Date.now() >= deadline) break
    await sleep(JOB_POLL_INTERVAL_MS)
  }
  const failing = (last?.services ?? [])
    .filter((service) => service.status !== 'READY')
    .map((service) => `${service.label}: ${service.status}`)
    .join('; ')
  throw new Error(
    `the demo system is ${last?.decision ?? 'unreachable'} rather than READY (${failing || 'no service detail'})`,
  )
}

type PresetEvidence = {
  presetId: string
  templateId: string
  roomId: string
  chainRoomId: string
  checkpointTx: Hex
  checkpointBlock: string
}

/** One preset, start to finish: template → room → deploy → scripted actions →
 * checkpoint → L1_ACCEPTED, returning the identifiers the evidence publishes. */
async function drivePreset(presetId: string): Promise<PresetEvidence> {
  const { presets } = await demoRequest<{ presets: DemoPresetView[] }>('GET', '/demo/v1/presets')
  const preset = presets.find((item) => item.id === presetId)
  if (!preset) {
    throw new Error(
      `the coordinator publishes no '${presetId}' preset (available: ${presets.map((item) => item.id).join(', ')})`,
    )
  }
  // The controller never runs preset actions on its own - `createRoom` and
  // `deployRoom` only stand the room up, and `checkpointRoom` proves whatever
  // `addAction` accepted (demo-controller.ts). A preset that publishes no
  // scripted actions (the card duel builds every move in the browser) cannot
  // be checkpointed headlessly, and saying so beats a later "each block needs
  // an action" refusal.
  if (preset.actions.length === 0) {
    throw new Error(
      `the '${presetId}' preset publishes no scripted actions, so this headless runner cannot legally checkpoint it`,
    )
  }

  progress(`Preparing the ${presetId} cold template.`)
  const created = await demoRequest<{ template: DemoTemplateView; job: DemoJobView }>(
    'POST',
    '/demo/v1/templates',
    {
      body: { name: `Example ${presetId} template`, presetId },
      idempotencyKey: idempotencyKey(`${presetId}-template`),
    },
  )
  await waitForJob(created.job.id, `preparing the ${presetId} template`)
  const template = await demoRequest<DemoTemplateView>(
    'GET',
    `/demo/v1/templates/${created.template.id}`,
  )
  if (template.phase !== 'ROOM_READY') {
    throw new Error(
      `the ${presetId} template finished in ${template.phase} rather than ROOM_READY`,
    )
  }

  progress(`Opening and deploying the ${presetId} room.`)
  const opened = await demoRequest<DemoRoomView>('POST', '/demo/v1/rooms', {
    // Do not restate the checkpoint policy here. The coordinator owns its
    // measured proof, inclusion, reorg and full-retry allowance and publishes
    // the preset-specific default through /demo/v1/room-settings.
    body: {
      name: `Example ${presetId} room`,
      templateId: template.id,
    },
    idempotencyKey: idempotencyKey(`${presetId}-room`),
  })
  // `createRoom` leaves the room ROOM_READY; the explicit deploy call is what
  // the controller requires before any move (demo-controller.ts deployRoom).
  if (opened.phase !== 'ACTIVE') {
    const deployJob = await demoRequest<DemoJobView>(
      'POST',
      `/demo/v1/rooms/${opened.id}/deploy`,
      { idempotencyKey: idempotencyKey(`${presetId}-deploy`) },
    )
    await waitForJob(deployJob.id, `deploying the ${presetId} room`)
  }
  const deployed = await demoRequest<DemoRoomView>('GET', `/demo/v1/rooms/${opened.id}`)
  if (deployed.phase !== 'ACTIVE' || !deployed.chainRoomId) {
    throw new Error(
      `the ${presetId} room is ${deployed.phase} without an on-chain room id after deployment`,
    )
  }

  progress(`Posting the ${preset.actions.length} scripted ${presetId} moves.`)
  for (const action of preset.actions) {
    // Calldata is deliberately omitted: `buildDemoAction` falls back to the
    // preset's own canned calldata, so the server stays the single source of
    // what each scripted move carries.
    await demoRequest('POST', `/demo/v1/rooms/${opened.id}/actions`, {
      body: { actionId: action.id, actorId: action.actor, block: action.recommendedBlock },
      idempotencyKey: idempotencyKey(`${presetId}-action-${action.id}`),
    })
  }

  progress(`Checkpointing the ${presetId} room to L1.`)
  const checkpointJob = await demoRequest<DemoJobView>(
    'POST',
    `/demo/v1/rooms/${opened.id}/checkpoints`,
    { idempotencyKey: idempotencyKey(`${presetId}-checkpoint`) },
  )
  await waitForJob(checkpointJob.id, `checkpointing the ${presetId} room`)
  const settled = await demoRequest<DemoRoomView>('GET', `/demo/v1/rooms/${opened.id}`)
  if (settled.phase !== 'L1_ACCEPTED' || !settled.checkpoint) {
    throw new Error(
      `the ${presetId} room finished in ${settled.phase} without an accepted checkpoint`,
    )
  }
  // `l1TransactionHash` is exempt from the response redaction exactly so a
  // client can verify it; a truncated or malformed hash here is a server bug.
  const checkpointTx = settled.checkpoint.l1TransactionHash
  if (!TRANSACTION_HASH.test(checkpointTx)) {
    throw new Error(`the ${presetId} checkpoint transaction hash is malformed: ${checkpointTx}`)
  }
  return {
    presetId,
    templateId: template.id,
    roomId: settled.id,
    chainRoomId: settled.chainRoomId!,
    checkpointTx: checkpointTx as Hex,
    checkpointBlock: settled.checkpoint.l1Block,
  }
}

/* ---------- the L1 fee and heartbeat assertions ---------- */

const TRANSACTION_INDEXING_RETRY_MS = 250

/** How long a single submitted tx is given to be mined before `sent` gives up
 *  on that hash. A tx that loses a same-account nonce race is REPLACED and its
 *  receipt never arrives, so an unbounded wait here hangs the whole run. */
const RECEIPT_TIMEOUT_MS = 45_000

async function sent(
  chain: ChainContext,
  wallet: RunnerWalletClient,
  address: Hex,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  value?: bigint,
) {
  const hash = await wallet.writeContract({
    account: wallet.account!,
    address,
    abi,
    functionName,
    args,
    chain: null,
    ...(value === undefined ? {} : { value }),
  })
  // Same devnet quirk `chain-ops` retries: the receipt may briefly answer
  // "transaction indexing is in progress" after inclusion.
  const deadline = Date.now() + Math.min(60_000, remainingBudgetMs())
  for (;;) {
    try {
      const receipt = await chain.publicClient.waitForTransactionReceipt({
        hash,
        timeout: Math.max(1, Math.min(RECEIPT_TIMEOUT_MS, remainingBudgetMs())),
      })
      if (receipt.status !== 'success') throw new Error(`${functionName} reverted`)
      return receipt
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('transaction indexing is in progress') || Date.now() >= deadline) {
        throw error
      }
      await sleep(TRANSACTION_INDEXING_RETRY_MS)
    }
  }
}

/** `AuthorizationMode.VALIDITY_ONLY` in RoomTypes.sol. */
const VALIDITY_ONLY = 1

type FeeEvidence = {
  chainRoomId: string
  feeBps: number
  depositWei: bigint
  feeAccruedDeltaWei: bigint
  depositTransaction: Hex
}

/** Queue one real native deposit into the example room and require the wired
 * 100 bps skim to land in `protocolFeeAccrued`, exactly as the deployment
 * promised (`setProtocolFee` in deployment.ts). */
async function assertProtocolFee(chain: ChainContext, chainRoomId: string): Promise<FeeEvidence> {
  const managerArtifact = await artifact(
    'web3-protocol/contracts/out/RoomManager.sol/RoomManager.json',
  )
  const interfaceArtifact = await artifact(
    'web3-protocol/contracts/out/IRoomManager.sol/IRoomManager.json',
  )
  const managerAbi = [...managerArtifact.abi, ...interfaceArtifact.abi] as Abi
  const manager = roomManager!
  const roomId = BigInt(chainRoomId)
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    chain.publicClient.readContract({ address: manager, abi: managerAbi, functionName, args }) as Promise<T>

  const feeBps = Number(await read<number | bigint>('protocolFeeBps'))
  if (feeBps !== PROTOCOL_FEE_BPS) {
    throw new Error(
      `the RoomManager charges ${feeBps} bps rather than the wired ${PROTOCOL_FEE_BPS}; the stand forgot setProtocolFee`,
    )
  }

  // viem answers a named object for the named `Room` tuple and a positional
  // array otherwise; the indices are IRoomManager.Room's field order.
  const state = await read<unknown>('roomState', [roomId])
  const named = state as Record<string, unknown>
  const at = (index: number, key: string): unknown =>
    Array.isArray(state) ? state[index] : named[key]
  const authorizationMode = Number(at(1, 'authorizationMode'))
  const admissionSigner = at(36, 'admissionSigner') as Hex
  const minimumServiceBond = BigInt(at(37, 'minimumServiceBond') as bigint)
  const serviceBond = BigInt(at(39, 'serviceBond') as bigint)

  // A VALIDITY_ONLY room refuses deposits until its accountability bond is
  // posted (`BondUnavailable` in RoomManagerIntakeFacet.queueDeposit), and only
  // the room's admission signer may post it. The demo coordinator signs
  // admissions with the node-service role key, which is exactly the account
  // `connectChain` derives - so this runner tops the bond up itself.
  //
  // That account is ALSO where the queue agent sends the room pool's on-chain
  // heartbeat (main.star prover-agent), so this top-up and a heartbeat can race
  // for the same nonce: the loser is replaced and its receipt never arrives.
  // Re-read the bond each attempt (so a stalled-but-eventually-mined top-up is
  // not double-counted) and resend on a stall - the few-wei top-up is additive,
  // so a duplicate is harmless.
  const readServiceBond = async (): Promise<bigint> => {
    const s = await read<unknown>('roomState', [roomId])
    return BigInt((Array.isArray(s) ? s[39] : (s as Record<string, unknown>).serviceBond) as bigint)
  }
  if (authorizationMode === VALIDITY_ONLY && serviceBond < minimumServiceBond) {
    if (admissionSigner.toLowerCase() !== chain.accounts.service.address.toLowerCase()) {
      throw new Error(
        'the room admission signer is not the enclave node-service account, so this runner cannot post the service bond',
      )
    }
    progress('Funding the service bond so the room accepts deposits.')
    for (let attempt = 0; ; attempt++) {
      if ((await readServiceBond()) >= minimumServiceBond) break
      try {
        await sent(
          chain,
          chain.wallets.service,
          manager,
          managerAbi,
          'fundServiceBond',
          [roomId],
          minimumServiceBond - (await readServiceBond()),
        )
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const racedNonce =
          /timed out|timeout|nonce|already known|replacement|underpriced/i.test(message)
        if (!racedNonce || attempt >= 4 || remainingBudgetMs() <= 15_000) throw error
        progress('Bond funding raced the node heartbeat for a nonce; resending.')
        await sleep(2_000)
      }
    }
  }

  progress('Queueing a real 0.1 ether deposit and reading the fee skim.')
  const before = await read<bigint>('protocolFeeAccrued', [roomId, zeroAddress])
  const receipt = await sent(
    chain,
    chain.wallet,
    manager,
    managerAbi,
    'queueDeposit',
    [roomId, zeroAddress, DEPOSIT_WEI, chain.deployer.address],
    DEPOSIT_WEI,
  )
  const after = await read<bigint>('protocolFeeAccrued', [roomId, zeroAddress])
  const delta = after - before
  const expected = expectedFeeWei(DEPOSIT_WEI, feeBps)
  if (delta !== expected) {
    throw new Error(
      `the deposit accrued ${delta} wei of protocol fee rather than the ${expected} wei a ${feeBps} bps skim takes`,
    )
  }
  return {
    chainRoomId,
    feeBps,
    depositWei: DEPOSIT_WEI,
    feeAccruedDeltaWei: delta,
    depositTransaction: receipt.transactionHash,
  }
}

/* ---------- the shared prove queue and the on-chain heartbeat ---------- */

type QueueNodeStats = {
  nodeId: string
  lastLeaseAt: string | null
  lastResultAt: string | null
  jobsDone: number
}

type QueueEvidence = {
  nodes: QueueNodeStats[]
  totalJobsDone: number
  heartbeat?: {
    nodeId: Hex
    lastHealthyBlockBefore: bigint
    lastHealthyBlockAfter: bigint
    observedSeconds: number
  }
}

async function collectQueueEvidence(chain: ChainContext): Promise<QueueEvidence> {
  progress('Reading the shared prove-queue status.')
  // `/queue/v1/status` is deliberately unauthenticated observability
  // (queue-routes.ts); it carries labels and counters, never request bytes.
  const response = await fetch(`${queueUrl}/queue/v1/status`, {
    signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, remainingBudgetMs()))),
  })
  if (!response.ok) {
    throw new Error(`the prove queue returned HTTP ${response.status} for its status`)
  }
  const status = (await response.json()) as { nodes?: QueueNodeStats[] }
  const nodes = Array.isArray(status.nodes) ? status.nodes : []
  if (nodes.length === 0) {
    throw new Error('the prove queue ran but no prover node ever leased from it')
  }
  const totalJobsDone = nodes.reduce(
    (sum, node) => sum + (Number.isInteger(node.jobsDone) ? node.jobsDone : 0),
    0,
  )
  if (totalJobsDone < 2) {
    throw new Error(
      `the prove queue carried ${totalJobsDone} finished job(s); this case alone needs a cold proof and a room proof`,
    )
  }
  const evidence: QueueEvidence = { nodes, totalJobsDone }

  if (roomPool) {
    // The queue agent also sends the room pool's on-chain heartbeat from the
    // registered service account (main.star prover-agent). Watching
    // `lastHealthyBlock` advance is liveness proved on the chain itself rather
    // than by an HTTP counter.
    const poolArtifact = await artifact(
      'web3-protocol/contracts/out/RoomPoolManager.sol/RoomPoolManager.json',
    )
    const readNode = () =>
      chain.publicClient.readContract({
        address: roomPool!,
        abi: poolArtifact.abi,
        functionName: 'nodeState',
        args: [nodeId],
      }) as Promise<NodeState>
    const before = (await readNode()).lastHealthyBlock
    progress('Watching the registered node heartbeat on the chain.')
    const started = Date.now()
    const windowMs = Math.min(HEARTBEAT_WINDOW_MS, Math.max(0, remainingBudgetMs() - 10_000))
    let after = before
    for (;;) {
      await sleep(Math.min(HEARTBEAT_POLL_INTERVAL_MS, Math.max(1, remainingBudgetMs())))
      after = (await readNode()).lastHealthyBlock
      if (after > before) break
      if (Date.now() - started >= windowMs) {
        throw new Error(
          `the registered node's lastHealthyBlock did not advance past ${before} within the ${Math.round(windowMs / 1_000)}s heartbeat window`,
        )
      }
    }
    evidence.heartbeat = {
      nodeId,
      lastHealthyBlockBefore: before,
      lastHealthyBlockAfter: after,
      observedSeconds: Math.round((Date.now() - started) / 1_000),
    }
  }
  return evidence
}

/* ---------- the run ---------- */

async function run(): Promise<void> {
  const script = EXAMPLE_CASE_PRESETS[exampleCase]
  if (!script) {
    throw new Error(
      `EXAMPLE_CASE must be one of ${EXAMPLE_CASES.join(', ')}; got ${JSON.stringify(exampleCase)}`,
    )
  }
  if (!l1RpcUrl) throw new Error('the Kurtosis L1 RPC URL is unavailable')
  if (!roomManager || !/^0x[0-9a-fA-F]{40}$/.test(roomManager)) {
    throw new Error('ROOM_MANAGER must name the deployed RoomManager address')
  }
  if (!Number.isFinite(configuredBudgetSeconds) || configuredBudgetSeconds <= 0) {
    throw new Error('RUNNER_TIMEOUT_SECONDS must be a positive number of seconds')
  }

  progress(`Waiting for the demo control plane to be READY for the ${exampleCase} case.`)
  await waitForReadySystem()
  const chain = await connectChain(l1RpcUrl)

  const presetEvidence: PresetEvidence[] = []
  for (const presetId of script) {
    presetEvidence.push(await drivePreset(presetId))
  }

  const fee = await assertProtocolFee(chain, presetEvidence[0]!.chainRoomId)
  const queue = queueUrl ? await collectQueueEvidence(chain) : undefined

  const evidence = {
    decision: 'VERIFIED',
    case: exampleCase,
    presets: presetEvidence,
    fee,
    ...(queue === undefined ? {} : { queue }),
  }
  // The runner gates its own artifact before publishing it, so the enclave and
  // a later `validate:example` read the same verdict from the same rules.
  const problems = validateExampleEvidence(jsonSafe(evidence))
  if (problems.length > 0) {
    throw new Error(`the produced evidence would not pass its own gate: ${problems.join('; ')}`)
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(jsonSafe(evidence), null, 2)}\n`, 'utf8')
  writeHumanReport({
    subject: `Example ${exampleCase} demo-plane acceptance`,
    decision: `Every ${exampleCase} preset room reached an L1-accepted checkpoint through the live coordinator.`,
    evidence: `The ${fee.feeBps} bps flow fee accrued on a real deposit${
      queue
        ? `, and the prove queue carried ${queue.totalJobsDone} job(s)${queue.heartbeat ? ' with a live on-chain heartbeat' : ''}`
        : ''
    }.`,
    nextAction: 'Gate the artifact with validate:example and publish it with the enclave record.',
    artifact: outputPath,
    resourceBudget: `${runnerBudgetSeconds}s of enclave budget over ${script.length} preset room(s) on the already-running stand.`,
  })
}

async function reportFailure(privateReason: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify({ decision: 'FAILED', case: exampleCase, privateReason })}\n`,
    'utf8',
  )
  writeHumanFailure(
    `Example ${exampleCase || 'demo'} demo-plane acceptance`,
    'No checkpoint, fee or queue observation from this run is accepted as evidence.',
    'Inspect the private example artifact, repair the failing boundary, and rerun the case.',
    outputPath,
  )
}

// The enclave kills the container at its own wait, and a killed process writes
// no evidence at all. This deadline fires first, so a stalled coordinator or a
// dead queue still produces a structured, diagnosable failure.
const watchdog = setTimeout(() => {
  void reportFailure(
    `the example run passed its ${runnerBudgetSeconds}s deadline without reaching a decision`,
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
