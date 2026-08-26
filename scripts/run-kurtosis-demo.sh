#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/kurtosis.sh
source "${ROOT}/scripts/lib/kurtosis.sh"
ENCLAVE="${ZKDEAL_ENCLAVE:-zkdeal-demo}"
KURTOSIS="$(resolve_kurtosis "$ROOT")"
require_kurtosis_sources "$ROOT"
RESET=false
NO_BUILD=false
for arg in "$@"; do
  [[ "$arg" == "--reset" ]] && RESET=true
  [[ "$arg" == "--no-build" ]] && NO_BUILD=true
done

print_links() {
  local tls explorer system summary state api_origin explorer_url grafana prometheus
  tls="$("$KURTOSIS" port print "$ENCLAVE" tls-gateway https --format ip,number 2>/dev/null || true)"
  explorer="$("$KURTOSIS" port print "$ENCLAVE" explorer http --format ip,number 2>/dev/null || true)"
  [[ "$tls" =~ ^[^:]+:[0-9]+$ ]] || {
    printf 'Decision: Long-running demo is not ready\n'
    printf 'Blocker: The TLS gateway has no published HTTPS port.\n'
    printf 'Next action: Inspect tls-gateway logs and restart with --reset.\n'
    return 1
  }
  [[ "$explorer" =~ ^[^:]+:[0-9]+$ ]] || {
    printf 'Decision: Long-running demo is not ready\n'
    printf 'Blocker: The public explorer service has no published web port.\n'
    printf 'Next action: Inspect explorer logs and restart with --reset.\n'
    return 1
  }
  system="$(curl --fail --silent --show-error --insecure --max-time 15 \
    "https://${tls}/demo/v1/system" 2>/dev/null || true)"
  [[ -n "$system" ]] || {
    printf 'Decision: Long-running demo is not ready\n'
    printf 'Blocker: The published HTTPS origin did not return the system report.\n'
    printf 'Next action: Inspect tls-gateway and zkdeal-demo logs, then restart with --reset.\n'
    return 1
  }
  summary="$(printf '%s' "$system" | node -e '
const chunks=[]
process.stdin.on("data", c => chunks.push(c))
process.stdin.on("end", () => {
  const s=JSON.parse(chunks.join(""))
  const ready=s?.decision==="READY" && s?.canary!=null && /^https:\/\/[^/]+$/.test(s?.apiUrl ?? "") && /^https?:\/\/[^/]+$/.test(s?.explorerUrl ?? "")
  process.stdout.write(`${ready ? "READY" : "NOT_READY"}\t${s?.apiUrl ?? ""}\t${s?.explorerUrl ?? ""}`)
})
' 2>/dev/null || true)"
  IFS=$'\t' read -r state api_origin explorer_url <<<"$summary"
  [[ "$state" == 'READY' ]] || {
    printf 'Decision: Long-running demo is not ready\n'
    printf 'Blocker: HTTPS is reachable, but the system report lacks READY, the L1 startup canary, or its HTTPS API identity.\n'
    printf 'Next action: Preserve the enclave and inspect the startup evidence before retrying.\n'
    return 1
  }
  printf 'Decision: Long-running demo is ready\n'
  printf 'Demo UI: %s/demo/\n' "$api_origin"
  printf 'L1 explorer: %s\n' "$explorer_url"
  # The observers are additive and may be absent on a legacy enclave, so a
  # missing service silently skips its line instead of failing the report.
  grafana="$("$KURTOSIS" port print "$ENCLAVE" grafana http --format ip,number 2>/dev/null || true)"
  if [[ "$grafana" =~ ^[^:]+:([0-9]+)$ ]]; then
    printf 'Grafana:  http://127.0.0.1:%s/\n' "${BASH_REMATCH[1]}"
  fi
  prometheus="$("$KURTOSIS" port print "$ENCLAVE" prometheus http --format ip,number 2>/dev/null || true)"
  if [[ "$prometheus" =~ ^[^:]+:([0-9]+)$ ]]; then
    printf 'Prometheus: http://127.0.0.1:%s/\n' "${BASH_REMATCH[1]}"
  fi
  printf 'API: %s/demo/v1/system\n' "$api_origin"
  printf 'Next action: Open the HTTPS UI and trust only this enclave certificate for capture.\n'
  printf 'Resource budget: Exactly one CUDA proving service, serialized through the persistent queue.\n'
}

if "$KURTOSIS" enclave inspect "$ENCLAVE" >/dev/null 2>&1; then
  if $RESET; then
    "$KURTOSIS" enclave rm "$ENCLAVE" --force >/dev/null
  else
    "$KURTOSIS" service start "$ENCLAVE" risc0-cuda-prover zkdeal-demo explorer tls-gateway >/dev/null 2>&1 || true
    # Separate call: a legacy enclave predating the observers would otherwise
    # fail the whole start list. This one may fail silently.
    "$KURTOSIS" service start "$ENCLAVE" prometheus grafana >/dev/null 2>&1 || true
    print_links
    exit $?
  fi
fi
$NO_BUILD || "$ROOT/scripts/build-docker-images.sh"
PARAMS="$ROOT/package/params/test.generated.yaml"
# --no-build skips the only producer of this file, and kurtosis/params/.gitignore
# keeps it out of every clean clone. Without this check Kurtosis fails with an
# args-file error routed into a temp log and the report below blames services.
[[ -f "$PARAMS" ]] || {
  printf 'Decision: Long-running demo did not start\n'
  printf 'Blocker: %s does not exist; --no-build skipped the step that generates it.\n' "$PARAMS"
  printf 'Next action: Run pnpm demo:start without --no-build to build the images and generate the args file.\n'
  printf 'Resource budget: No Kurtosis enclave was created.\n'
  exit 1
}
LOG="${TMPDIR:-/tmp}/zkdeal-demo-kurtosis.log"
printf 'Preparing: local Ethereum, Blockscout, CUDA prover and startup room\n'
if ! "$KURTOSIS" run "$ROOT/package" \
  --args-file "$PARAMS" \
  --enclave "$ENCLAVE" --verbosity BRIEF --image-download missing >"$LOG" 2>&1; then
  printf 'Decision: Long-running demo did not start\n'
  printf 'Blocker: A service or the real startup proof failed its readiness gate.\n'
  printf 'Next action: Inspect the private Kurtosis log and restart with --reset.\n'
  printf 'Evidence saved: %s\n' "$LOG"
  exit 1
fi
print_links
