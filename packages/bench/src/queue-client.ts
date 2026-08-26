import { PROOF_REQUEST_CEILING_MS, remainingBudgetMs } from './runner-env.ts'
import type { ProofResult } from './prover-client.ts'

/// The prover boundary carried over the shared prove queue instead of a
/// direct socket: submit the job, poll once a second, fetch the verbatim
/// prover JSON. Same exported signatures as prover-client.ts, so the
/// dispatcher there can swap transports without any caller noticing - and
/// the same single wall-clock budget: every poll comes out of the run's
/// remaining time, never on top of it.

const POLL_INTERVAL_MS = 1_000

function queueUrl(): string {
  const url = process.env.QUEUE_URL
  if (!url) throw new Error('QUEUE_URL is required when proving via the shared queue')
  return url.replace(/\/+$/, '')
}

function headers(): Record<string, string> {
  const token = process.env.ZKDEAL_QUEUE_SUBMIT_TOKEN
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const body = await response.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(
      `the prove queue returned HTTP ${response.status} for ${label} with an unreadable body: ${body.slice(0, 200)}`,
    )
  }
}

export async function requestJson<T>(endpoint: string, request: unknown): Promise<T> {
  const deadline = Date.now() + Math.min(PROOF_REQUEST_CEILING_MS, remainingBudgetMs())
  const base = queueUrl()
  const submitted = await fetch(`${base}/queue/v1/jobs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ endpoint, request }),
    signal: AbortSignal.timeout(60_000),
  })
  const submission = (await readJson(submitted, endpoint)) as { jobId?: string; error?: string }
  if (!submitted.ok || !submission.jobId) {
    throw new Error(
      `the prove queue refused ${endpoint}: HTTP ${submitted.status}${
        submission.error ? ` ${submission.error}` : ''
      }`,
    )
  }
  const jobId = submission.jobId
  while (Date.now() < deadline) {
    const polled = await fetch(`${base}/queue/v1/jobs/${jobId}`, {
      headers: headers(),
      signal: AbortSignal.timeout(30_000),
    })
    const job = (await readJson(polled, endpoint)) as {
      status?: string
      failure?: { reason?: string }
    }
    if (!polled.ok) throw new Error(`the prove queue lost job ${jobId} for ${endpoint}`)
    if (job.status === 'FAILED') {
      // The queue's recorded reason is the prover's own words (the agent
      // relays the rejection body), so the failure reads the same as a
      // direct call's would.
      throw new Error(
        `the prove queue failed ${endpoint}${job.failure?.reason ? `: ${job.failure.reason}` : ''}`,
      )
    }
    if (job.status === 'DONE') {
      const fetched = await fetch(`${base}/queue/v1/jobs/${jobId}/result`, {
        headers: headers(),
        signal: AbortSignal.timeout(60_000),
      })
      const result = (await readJson(fetched, endpoint)) as T & {
        decision?: string
        reason?: string
      }
      if (!fetched.ok || result.decision === 'request-rejected') {
        throw new Error(
          `the CUDA prover returned a rejection through the queue for ${endpoint}${
            result.reason ? `: ${result.reason}` : ''
          }`,
        )
      }
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`the prove queue did not finish ${endpoint} inside the run budget`)
}

export async function requestProof(endpoint: string, request: unknown): Promise<ProofResult> {
  const started = performance.now()
  const result = await requestJson<ProofResult>(endpoint, request)
  if (!result.ethereumSealB64 || result.proofMode !== 'groth16') {
    throw new Error(`the CUDA prover did not return an Ethereum Groth16 seal for ${endpoint}`)
  }
  return { ...result, elapsedMs: performance.now() - started }
}
