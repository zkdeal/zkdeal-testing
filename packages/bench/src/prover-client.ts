import type { Hex } from 'viem'
import {
  requestJson as queueRequestJson,
  requestProof as queueRequestProof,
} from './queue-client.ts'
import { PROOF_REQUEST_CEILING_MS, proverUrl, remainingBudgetMs } from './runner-env.ts'

/// The HTTP boundary to the enclave's CUDA prover: the shapes it answers with
/// and the two request helpers that keep every call inside the run budget.
///
/// Also the transport dispatcher: PROVE_VIA=queue (with QUEUE_URL set) swaps
/// the direct prover socket for the shared prove queue (queue-client.ts) -
/// same signatures, same budget, same failure stories - so no caller has to
/// know which transport carried its proof. Default stays direct: the GPU
/// calibration bootstrap must keep measuring the raw device.

/** Decided per call, not at import: the runner sets env before the first use. */
function viaQueue(): boolean {
  return process.env.PROVE_VIA === 'queue' && Boolean(process.env.QUEUE_URL)
}

export type ProofResult = {
  ethereumSealB64: string
  journal?: Record<string, unknown>
  journalHash?: Hex
  profile: Record<string, number>
  programId: Hex
  proofMode: string
  statement?: Hex
  templateId?: Hex
  /** Cold-template proofs only: keccak256 of the framed canonical witness. */
  genesisDataHash?: Hex
  /** Cold-template proofs only: base64 of the framed canonical witness bytes. */
  canonicalColdTemplateDataB64?: string
  elapsedMs?: number
  imageId?: string
  cycles?: number
  totalCycles?: number
  segments?: number
  gpuUuid?: string
  gpuName?: string
  utilizationSamplesPercent?: number[]
  vramSamplesMiB?: number[]
  powerSamplesW?: number[]
  containerDigest?: string
}

/// What `/v5/rooms/prepare` answers with: the two proving requests plus the
/// workload descriptor and contract configuration the runner checks before it
/// spends any GPU time.
export type PreparedRoom = {
  coldRequest: Record<string, unknown>
  roomRequest: {
    roomWitness: {
      canonical_batch_data: Hex
      approver_changes: unknown[]
      admissions: unknown[]
      forced_transactions: Array<{ outcome: unknown }>
      post_liabilities: unknown[]
    }
    [key: string]: unknown
  }
  contractConfig?: {
    initialApproverRoot?: Hex
    initialActiveCount?: number
    /** keccak256 of the framed canonical cold witness bytes below. */
    genesisDataHash?: Hex
    /** The exact framed canonical witness bytes (0x-hex) the registry binds. */
    canonicalColdTemplateData?: Hex
  }
  measurement?: Record<string, unknown> & { activeSigners?: number }
}

export async function requestJson<T>(endpoint: string, request: unknown): Promise<T> {
  if (viaQueue()) return queueRequestJson<T>(endpoint, request)
  const response = await fetch(`${proverUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(Math.min(PROOF_REQUEST_CEILING_MS, remainingBudgetMs())),
  })
  // Read the body once as text: the prover answers every outcome in JSON, but a
  // status code is the one field that separates a rejected request from a
  // prover-side task failure, and it must survive an unparsable body too.
  const body = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(
      `the CUDA prover returned HTTP ${response.status} for ${endpoint} with an unreadable body: ${body.slice(0, 200)}`,
    )
  }
  const result = parsed as T & { decision?: string; reason?: string; effect?: string }
  if (!response.ok || result.decision === 'request-rejected') {
    const reason = result.reason ?? result.effect ?? body.slice(0, 200)
    throw new Error(`the CUDA prover returned HTTP ${response.status} for ${endpoint}: ${reason}`)
  }
  return result
}

export async function requestProof(endpoint: string, request: unknown): Promise<ProofResult> {
  if (viaQueue()) return queueRequestProof(endpoint, request)
  const started = performance.now()
  const result = await requestJson<ProofResult>(endpoint, request)
  if (!result.ethereumSealB64 || result.proofMode !== 'groth16') {
    throw new Error(`the CUDA prover did not return an Ethereum Groth16 seal for ${endpoint}`)
  }
  return { ...result, elapsedMs: performance.now() - started }
}
