#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/kurtosis.sh
source "${ROOT}/scripts/lib/kurtosis.sh"
ENCLAVE="${ZKDEAL_ENCLAVE:-zkdeal-demo}"
KURTOSIS="$(resolve_kurtosis "$ROOT")"
if ! "$KURTOSIS" enclave inspect "$ENCLAVE" >/dev/null 2>&1; then
  printf 'Decision: Long-running demo is stopped\n'
  printf 'Evidence: No persistent demo enclave is available.\n'
  printf 'Next action: Run pnpm demo:start.\n'
  printf 'Resource budget: No GPU slot is reserved.\n'
  exit 1
fi
DEMO="$("$KURTOSIS" port print "$ENCLAVE" zkdeal-demo http --format ip,number)"
SYSTEM="$(curl --fail --silent --max-time 8 "http://${DEMO}/demo/v1/system" || true)"
if [[ -z "$SYSTEM" ]]; then
  printf 'Decision: Demo console is not healthy\n'
  printf 'Blocker: The control plane did not return a readable system report.\n'
  printf 'Next action: Inspect the enclave service logs and restart only the failed service.\n'
  printf 'Resource budget: The enclave and its evidence remain preserved.\n'
  exit 1
fi
# A 2xx alone does not mean the room is ready: the startup Groth16 canary
# reaching L1 is the single property this demo exists to demonstrate. The demo
# console reports that as a non-null `canary` block (server/src/demo-control.ts
# DemoSystemStatus), which is also what web/components/long-running-demo.tsx
# treats as L1_ACCEPTED. Keep this decision identical to demo-status.ps1.
SUMMARY="$(printf '%s' "$SYSTEM" | node -e '
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const system = JSON.parse(chunks.join(""))
  const ready = system?.decision === "READY" && system?.canary != null
  const services = Array.isArray(system?.services) ? system.services.length : 0
  process.stdout.write(`${ready ? "ready" : "incomplete"}\t${services}\t${system?.gpu?.recommendedProofSeconds ?? "unknown"}`)
})
' 2>/dev/null || true)"
[[ -n "$SUMMARY" ]] || {
  printf 'Decision: Demo console is not healthy\n'
  printf 'Blocker: The system report was not readable JSON.\n'
  printf 'Next action: Inspect the enclave service logs and restart only the failed service.\n'
  printf 'Resource budget: The enclave and its evidence remain preserved.\n'
  exit 1
}
IFS=$'\t' read -r CANARY SERVICES GPU_SECONDS <<<"$SUMMARY"
if [[ "$CANARY" == 'ready' ]]; then
  printf 'Decision: Long-running demo is ready\n'
else
  printf 'Decision: Demo is running; startup canary is incomplete\n'
fi
printf 'Evidence: %s services reported; GPU allowance is %s seconds.\n' "$SERVICES" "$GPU_SECONDS"
printf 'Demo UI: http://%s/demo/\n' "$DEMO"
printf 'API: http://%s/demo/v1/system\n' "$DEMO"
# The observers are additive and may be absent on a legacy enclave, so a
# missing service silently skips its line instead of failing the report.
GRAFANA="$("$KURTOSIS" port print "$ENCLAVE" grafana http --format ip,number 2>/dev/null || true)"
if [[ "$GRAFANA" =~ ^[^:]+:([0-9]+)$ ]]; then
  printf 'Grafana:  http://127.0.0.1:%s/\n' "${BASH_REMATCH[1]}"
fi
PROMETHEUS="$("$KURTOSIS" port print "$ENCLAVE" prometheus http --format ip,number 2>/dev/null || true)"
if [[ "$PROMETHEUS" =~ ^[^:]+:([0-9]+)$ ]]; then
  printf 'Prometheus: http://127.0.0.1:%s/\n' "${BASH_REMATCH[1]}"
fi
printf 'Next action: Continue the live presentation or create another room.\n'
printf 'Resource budget: One local CUDA proving slot, serialized through the persistent queue.\n'
