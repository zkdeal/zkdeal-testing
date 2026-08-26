#!/usr/bin/env bash
# Run the Kurtosis acceptance stack on geth/Lighthouse + a real CUDA prover
# and gate the evidence artifact it emits. Kept in lockstep with the PowerShell
# twin; run-platform.mjs picks one by host OS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/kurtosis.sh
source "${ROOT}/scripts/lib/kurtosis.sh"
REPLACE=0
CASE="${ZKDEAL_CASE:-base}"
expect_case=0
for arg in "$@"; do
  if [[ "$expect_case" -eq 1 ]]; then CASE="$arg"; expect_case=0; continue; fi
  case "$arg" in
    --replace) REPLACE=1 ;;
    --case) expect_case=1 ;;
    --case=*) CASE="${arg#--case=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[[ "$expect_case" -eq 0 ]] || { echo '--case needs a value' >&2; exit 2; }
export ZKDEAL_CASE="$CASE"
if [[ "$CASE" == "base" ]]; then
  ARGS_FILE="${ROOT}/package/params/test.generated.yaml"
else
  ARGS_FILE="${ROOT}/package/params/cases/${CASE}.generated.yaml"
fi

# The enclave run is worthless without the validator it ends with. Check that
# packages/bench still defines it before reserving the GPU rather than after.
if ! node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts ?? {}; process.exit(s["validate"] ? 0 : 1)' \
  "${ROOT}/packages/bench/package.json" 2>/dev/null; then
  echo 'Decision: The acceptance run was not started' >&2
  echo 'Blocker: packages/bench no longer defines the validate evidence validator this runner ends with.' >&2
  echo 'Next action: Restore the evidence validator before running the acceptance gate.' >&2
  echo 'Resource budget: No image was built, no GPU was reserved and no enclave was created.' >&2
  exit 1
fi

ENCLAVE="${ZKDEAL_ENCLAVE:-zkdeal-test-$(date -u +%Y%m%d-%H%M%S)-$$}"
# Non-base cases end with a second validator over the example evidence.
if [[ "$CASE" != "base" ]] && ! node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts ?? {}; process.exit(s["validate:example"] ? 0 : 1)' \
  "${ROOT}/packages/bench/package.json" 2>/dev/null; then
  echo 'Decision: The example acceptance run was not started' >&2
  echo 'Blocker: packages/bench no longer defines the validate:example evidence validator.' >&2
  exit 1
fi
KURTOSIS="$(resolve_kurtosis "$ROOT")"
require_kurtosis_sources "$ROOT"
bash "${ROOT}/scripts/build-docker-images.sh"
prepare_enclave "$KURTOSIS" "$ENCLAVE" "$REPLACE"
EVIDENCE_DIR="${ZKDEAL_INTEGRATION_EVIDENCE_DIR:-${ROOT}/test-results/hosting-gpu-integration/${ENCLAVE}}"
OUT_LOG="${ROOT}/kurtosis-test-out.log"
ERR_LOG="${ROOT}/kurtosis-test-err.log"
mkdir -p "$EVIDENCE_DIR"
set +e
"$KURTOSIS" run "${ROOT}/package" \
  --args-file "$ARGS_FILE" \
  --enclave "$ENCLAVE" \
  --verbosity detailed \
  --image-download missing >"$OUT_LOG" 2>"$ERR_LOG"
status=$?
set -e
if [[ "$status" -ne 0 ]]; then
  echo "Kurtosis acceptance failed; preserving logs and enclave for inspection." >&2
  set +e
  "$KURTOSIS" enclave inspect "$ENCLAVE" >"$EVIDENCE_DIR/enclave-inspect.txt" 2>&1
  "$KURTOSIS" service logs "$ENCLAVE" --all-services --all >"$EVIDENCE_DIR/all-service-logs.txt" 2>&1
  "$KURTOSIS" enclave dump "$ENCLAVE" "$EVIDENCE_DIR/enclave-dump" >"$EVIDENCE_DIR/enclave-dump-command.txt" 2>&1
  cp "$OUT_LOG" "$ERR_LOG" "$EVIDENCE_DIR/" 2>/dev/null
  set -e
  tail -n 100 "$OUT_LOG" || true
  exit "$status"
fi
# The one artifact package/main.star stores (StoreSpec zkdeal-v5-kurtosis-evidence).
"$KURTOSIS" files download "$ENCLAVE" zkdeal-v5-kurtosis-evidence "$EVIDENCE_DIR"
EVIDENCE="$(find "$EVIDENCE_DIR" -name v5-kurtosis-evidence.json -type f -print -quit)"
[[ -n "$EVIDENCE" ]] || { echo 'the acceptance evidence artifact was not downloaded' >&2; exit 1; }
(cd "$ROOT" && pnpm --filter @zkdeal/bench validate "$EVIDENCE")
if [[ "$CASE" != "base" ]]; then
  "$KURTOSIS" files download "$ENCLAVE" "zkdeal-example-${CASE}-evidence" "$EVIDENCE_DIR"
  EXAMPLE_EVIDENCE="$(find "$EVIDENCE_DIR" -name example-evidence.json -type f -print -quit)"
  [[ -n "$EXAMPLE_EVIDENCE" ]] || { echo "the ${CASE} example evidence artifact was not downloaded" >&2; exit 1; }
  (cd "$ROOT" && pnpm --filter @zkdeal/bench validate:example "$EXAMPLE_EVIDENCE")
fi
cp "$ARGS_FILE" "$EVIDENCE_DIR/"
cp "${ROOT}/../prover-node/zkvm/artifacts.lock.json" "$EVIDENCE_DIR/"
echo "==> real-proof CUDA/L1 acceptance evidence validated (case: ${CASE}): $EVIDENCE"
# Best-effort pointer at the enclave's browser surfaces on their fixed host
# ports (main.star / observability.star). Tolerant of absence and never allowed
# to affect the exit code of a validated acceptance run.
LINKS=""
if "$KURTOSIS" port print "$ENCLAVE" explorer http >/dev/null 2>&1; then
  LINKS="L1 explorer: http://127.0.0.1:3200"
fi
if "$KURTOSIS" port print "$ENCLAVE" grafana http >/dev/null 2>&1; then
  LINKS="${LINKS}${LINKS:+  }Grafana: http://127.0.0.1:3300"
fi
if "$KURTOSIS" port print "$ENCLAVE" prometheus http >/dev/null 2>&1; then
  LINKS="${LINKS}${LINKS:+  }Prometheus: http://127.0.0.1:9090"
fi
if [[ -n "$LINKS" ]]; then
  echo "$LINKS"
fi
exit 0
