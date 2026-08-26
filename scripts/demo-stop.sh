#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/kurtosis.sh
source "${ROOT}/scripts/lib/kurtosis.sh"
ENCLAVE="${ZKDEAL_ENCLAVE:-zkdeal-demo}"
KURTOSIS="$(resolve_kurtosis "$ROOT")"
if "$KURTOSIS" service stop "$ENCLAVE" zkdeal-demo risc0-cuda-prover >/dev/null 2>&1; then
  printf 'Decision: Demo console and GPU prover are stopped\n'
  printf 'Evidence: Rooms, jobs and proof evidence remain in the enclave.\n'
  printf 'Evidence: Local Ethereum remains available so its chain history is not discarded.\n'
  printf 'Next action: Run pnpm demo:start to resume without resetting.\n'
  printf 'Resource budget: The GPU proving slot has been released.\n'
else
  printf 'Decision: Demo was already stopped or unavailable\n'
  printf 'Evidence: No running service was changed.\n'
  printf 'Next action: Run pnpm demo:start when the presentation is needed.\n'
fi
