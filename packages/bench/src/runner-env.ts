import { humanText } from '../../../scripts/lib/human-report.mts'

/// The process environment the acceptance run reads, the single wall-clock
/// budget every wait inside it is carved out of, and the redacted progress
/// channel. Nothing here talks to a chain or a prover.

export const root = process.env.APP_ROOT ?? '/app'
export const outputPath = process.env.OUT_PATH ?? '/out/v5-kurtosis-evidence.json'
export const proverUrl = process.env.PROVER_URL ?? 'http://risc0-cuda-prover:8080'
export const l1RpcUrl = process.env.L1_RPC_URL

// Kurtosis kills this container at its own `runner_timeout` (45m by default).
// Every wait inside the run is bounded by a slice of the same budget so the
// structured failure file is always written before the enclave takes the
// process away. Set RUNNER_TIMEOUT_SECONDS whenever the enclave wait changes.
const DEFAULT_RUNNER_BUDGET_SECONDS = 45 * 60
export const configuredBudgetSeconds = Number(
  process.env.RUNNER_TIMEOUT_SECONDS ?? DEFAULT_RUNNER_BUDGET_SECONDS,
)
export const runnerBudgetSeconds =
  Number.isFinite(configuredBudgetSeconds) && configuredBudgetSeconds > 0
    ? configuredBudgetSeconds
    : DEFAULT_RUNNER_BUDGET_SECONDS
// Nine tenths of the enclave budget: the last tenth is what the run needs to
// write its own failure evidence before Kurtosis reclaims the container.
const runnerDeadlineMs = Date.now() + runnerBudgetSeconds * 1_000 * 0.9
export const PROOF_REQUEST_CEILING_MS = 20 * 60 * 1000
export const remainingBudgetMs = () => Math.max(0, runnerDeadlineMs - Date.now())

// A forty-minute run that prints nothing cannot be told apart from a hung one.
// Phases go to stderr, redacted, so the machine decision on stdout stays a
// single block.
export function progress(phase: string): void {
  process.stderr.write(`Progress: ${humanText(phase)}\n`)
}
