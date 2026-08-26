#!/usr/bin/env bash
# Build the zkdeal Kurtosis image set and write the generated READY args file
# `kurtosis run` consumes. There is no CPU prover fallback.
#
# `kurtosis/main.star` declares exactly three locally built images - prover,
# runner and server - plus two digest-pinned upstream L1 images it does not
# build. This script is their single producer; `kurtosis/params/test.yaml` is
# its only template. Kept in lockstep with build-docker-images.ps1: every
# divergence between the pair is an OS-dependent behaviour change, because
# run-platform.mjs picks one by host OS.
set -euo pipefail
# MSYS/Git-Bash rewrites POSIX-looking docker args ("-v /c/…/web3-protocol:/workspace"
# becomes "C:\…\web3-protocol;C:\Program Files\Git\workspace"), which mounts the
# wrong source, sets the wrong workdir, and litters the repo root with an empty
# "web3-protocol;C" directory. On Windows this script's PowerShell twin is the
# supported path (run-platform.mjs picks it automatically).
case "$(uname -s 2>/dev/null || true)" in
  MINGW*|MSYS*|CYGWIN*)
    printf 'Decision: Kurtosis images are not ready\n'
    printf 'Blocker: Git-Bash/MSYS path conversion corrupts docker -v/-w arguments on Windows.\n'
    printf 'Next action: run `pnpm -C kurtosis-testing build:images` (dispatches to build-docker-images.ps1), or run this script from WSL2/Linux.\n'
    printf 'Resource budget: No Kurtosis enclave was started.\n'
    exit 1
    ;;
esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The umbrella checkout holding the sibling component folders whose sources
# these images are built from (prover-node, web2-api, web3-protocol, app-node).
UMBRELLA="$(cd "$ROOT/.." && pwd)"
LOG_ROOT="${TMPDIR:-/tmp}/zkdeal-image-build"
mkdir -p "$LOG_ROOT"
cd "$ROOT"

fail() {
  printf 'Decision: Kurtosis images are not ready\n'
  printf 'Blocker: %s\n' "$1"
  printf 'Next action: %s\n' "$2"
  [[ -z "${3:-}" ]] || printf 'Evidence saved: %s\n' "$3"
  printf 'Resource budget: No Kurtosis enclave was started.\n'
  exit 1
}

run_logged() {
  local label="$1"; shift
  local log="$LOG_ROOT/$(printf '%s' "$label" | tr -cs 'A-Za-z0-9-' '-').log"
  printf 'Preparing: %s\n' "$label"
  if ! "$@" >"$log" 2>&1; then
    fail "${label} did not complete." 'Inspect the private build log and correct the dependency.' "$log"
  fi
}

# Verify the template up front, before the multi-hour CUDA, Foundry and docker
# work: a renamed or re-indented image key must not be discovered after the
# build, and a partially applied run must never overwrite the args file Kurtosis
# actually runs with an incompatible key set.
#
# ZKDEAL_CASE selects the example case template (base = the bootstrap
# acceptance alone; see package/params/cases/).
CASE="${ZKDEAL_CASE:-base}"
if [[ "$CASE" == "base" ]]; then
  TEMPLATE="${ROOT}/package/params/test.yaml"
  OUTPUT="${ROOT}/package/params/test.generated.yaml"
else
  TEMPLATE="${ROOT}/package/params/cases/${CASE}.yaml"
  OUTPUT="${ROOT}/package/params/cases/${CASE}.generated.yaml"
fi
[[ -f "$TEMPLATE" ]] || fail "the params template for case '${CASE}' does not exist." \
  'Restore the checked-in Kurtosis params template (package/params/, cases/).'
for key in prover runner server; do
  grep -q "^  ${key}: NOT_BUILT\$" "$TEMPLATE" || fail \
    "package/params/test.yaml does not declare the ${key} image key this builder substitutes." \
    'Realign this script with package/params/test.yaml and package/main.star.'
done

# set -e aborts on a failing assignment, so a missing driver has to be captured
# rather than propagated; otherwise the named report below is unreachable and
# the operator sees a raw "nvidia-smi: command not found".
GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader -i 0 2>/dev/null | head -n1 || true)"
[[ -n "$GPU_NAME" ]] || fail 'nvidia-smi did not report a device 0 on this host.' \
  'Install or repair the NVIDIA driver, then build the images again.'

# The prover kernels must match the device this stack actually proves on. A
# hardcoded arch drifts from the PowerShell twin and silently builds, say,
# sm_86 kernels for an sm_89 card, which invalidates any latency comparison.
CUDA_ARCH="${ZKDEAL_CUDA_ARCH:-$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader -i 0 2>/dev/null | head -n1 | tr -cd '0-9' || true)}"
[[ "$CUDA_ARCH" =~ ^[0-9]{2,3}$ ]] || fail \
  'The CUDA compute capability of device 0 could not be read.' \
  'Update the NVIDIA driver or set ZKDEAL_CUDA_ARCH to the device compute capability, e.g. 89.'

# The stack deploys these contracts, so they must be compiled by the same
# digest-pinned image CI uses. A mutable tag makes the deployed bytecode
# unreproducible; the pin lives in one file so it cannot drift per script.
FOUNDRY_IMAGE="$(grep -v '^[[:space:]]*#' "$UMBRELLA/web3-protocol/contracts/foundry-image.txt" | grep -m1 '[^[:space:]]' || true)"
[[ "$FOUNDRY_IMAGE" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || fail \
  'web3-protocol/contracts/foundry-image.txt does not pin one image@sha256:<digest> reference.' \
  'Restore the pinned Foundry digest before compiling deployed contracts.'

MANIFEST_SCRIPT="$UMBRELLA/prover-node/zkvm/scripts/check-lock-freshness.mjs"
MANIFEST_CANDIDATE="$UMBRELLA/prover-node/zkvm/source-manifest.candidate.json"
run_logged 'deterministic source manifest' node "$MANIFEST_SCRIPT" --prepare-build-input
OBSERVED_SNAPSHOT="$(sha256sum "$MANIFEST_CANDIDATE" | cut -d' ' -f1)"
[[ "$OBSERVED_SNAPSHOT" =~ ^[0-9a-f]{64}$ ]] || fail \
  'The deterministic source manifest does not have a valid SHA-256 digest.' \
  'Repair the source-manifest generator before building images.'
if [[ -n "${ZKDEAL_SOURCE_SNAPSHOT_SHA256:-}" && "$ZKDEAL_SOURCE_SNAPSHOT_SHA256" != "$OBSERVED_SNAPSHOT" ]]; then
  fail 'ZKDEAL_SOURCE_SNAPSHOT_SHA256 does not match the current source bytes.' \
    'Use the digest emitted by the deterministic source-manifest step.'
fi
REVISION="$OBSERVED_SNAPSHOT"
IMAGE_TAG="${ZKDEAL_IMAGE_TAG:-snapshot-${REVISION:0:12}}"
[[ "$IMAGE_TAG" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || fail \
  'ZKDEAL_IMAGE_TAG is not a valid immutable Docker tag.' \
  'Use a lowercase build identity such as recording-20260731-061500.'
PROVER_TAG="zkdeal-risc0-cuda-runtime:${IMAGE_TAG}"
SERVER_TAG="zkdeal-coordinator:${IMAGE_TAG}"
RUNNER_TAG="zkdeal-bench:${IMAGE_TAG}"

run_logged 'Solidity contracts' docker run --rm --entrypoint forge \
  -v "$UMBRELLA/web3-protocol:/workspace" -w /workspace/contracts "$FOUNDRY_IMAGE" build
run_logged 'single-GPU prover' docker build --target runtime \
  -f "$UMBRELLA/prover-node/zkvm/docker/risc0-cuda.Dockerfile" \
  --build-arg "CUDA_ARCH=${CUDA_ARCH}" \
  --build-arg "SOURCE_MANIFEST_SHA256=$REVISION" -t "$PROVER_TAG" "$UMBRELLA/prover-node"
run_logged 'web console and API' docker build \
  -f "$UMBRELLA/web2-api/server/Dockerfile" -t "$SERVER_TAG" "$UMBRELLA"
# main.star runs packages/bench inside the coordinator image; the runner is that
# same image under the key the package reads.
run_logged 'acceptance runner' docker tag "$SERVER_TAG" "$RUNNER_TAG"
run_logged 'CUDA preflight' docker run --rm --gpus device=0 \
  -e RISC0_DEV_MODE=0 -e RISC0_REQUIRE_CUDA=1 "$PROVER_TAG" health

sed \
  -e 's/^status: NOT_RUN$/status: READY/' \
  -e "s|^gpu_name: CURRENT_GPU_NOT_MEASURED$|gpu_name: \"${GPU_NAME//\"/}\"|" \
  -e "s|^  prover: NOT_BUILT$|  prover: $PROVER_TAG|" \
  -e "s|^  runner: NOT_BUILT$|  runner: $RUNNER_TAG|" \
  -e "s|^  server: NOT_BUILT$|  server: $SERVER_TAG|" \
  "$TEMPLATE" > "$OUTPUT"
# Per-stand prover sizing without editing tracked templates. An explicit
# ZKDEAL_SEGMENT_PO2 always wins; otherwise the segment size is chosen from the
# device's VRAM, because a value too large for the card OOMs the Groth16 wrap
# and produces no proof at all (see scripts/pick-segment-po2.mjs and
# docs/GPU-SEGMENT-SIZING.md).
if [[ -n "${ZKDEAL_SEGMENT_PO2:-}" ]]; then
  [[ "$ZKDEAL_SEGMENT_PO2" =~ ^(18|19|20|21)$ ]] || fail \
    'ZKDEAL_SEGMENT_PO2 must be one of 18, 19, 20, 21.' \
    'Pick the largest segment size the proving GPU fits.'
  SEGMENT_PO2="$ZKDEAL_SEGMENT_PO2"
else
  VRAM_MIB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits -i 0 2>/dev/null | head -n1 | tr -cd '0-9' || true)"
  [[ "$VRAM_MIB" =~ ^[0-9]+$ ]] || fail \
    'The total VRAM of device 0 could not be read to size the prover.' \
    'Update the NVIDIA driver or set ZKDEAL_SEGMENT_PO2 explicitly.'
  SEGMENT_PO2="$(node "${ROOT}/scripts/pick-segment-po2.mjs" "$VRAM_MIB" "$GPU_NAME")" || fail \
    'The segment size could not be derived from the device VRAM.' \
    'Set ZKDEAL_SEGMENT_PO2 explicitly.'
fi
sed -i "s|^segment_po2: \"[0-9]*\"$|segment_po2: \"${SEGMENT_PO2}\"|" "$OUTPUT"
if [[ -n "${ZKDEAL_PUBLIC_HOST:-}" ]]; then
  [[ "$ZKDEAL_PUBLIC_HOST" =~ ^[a-zA-Z0-9.-]+$ ]] || fail \
    'ZKDEAL_PUBLIC_HOST is not a valid host name or IP address.' \
    'Set it to the capture-visible host without a scheme or port.'
  sed -i "s|^public_host: \"127\\.0\\.0\\.1\"$|public_host: \"${ZKDEAL_PUBLIC_HOST}\"|" "$OUTPUT"
fi
# This is the file Kurtosis actually runs. Every placeholder token, not just the
# five substituted above: a renamed or re-indented template key must not reach
# Kurtosis as an unresolvable image or an unmeasured GPU identity in evidence.
if grep -Eq 'NOT_BUILT|NOT_RUN|NOT_MEASURED|_NOT_SET' "$OUTPUT"; then
  fail "${OUTPUT} still contains an unsubstituted template placeholder." \
    'Realign this script substitutions with kurtosis/params/test.yaml.' "$OUTPUT"
fi

printf 'Decision: Kurtosis images are ready\n'
printf 'Evidence: Contracts, web console, acceptance runner and one-GPU prover passed their build checks for %s.\n' "$GPU_NAME"
printf 'Next action: Start or resume the zkdeal enclave.\n'
printf 'Evidence saved: %s\n' "$LOG_ROOT"
printf 'Resource budget: One local CUDA device; no proof was generated by the build step.\n'
