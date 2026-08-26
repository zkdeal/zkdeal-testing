#!/usr/bin/env bash
# Shared helpers for the scripts/run-kurtosis-*.sh runners.
# Kept in lockstep with scripts/lib/kurtosis.ps1 - change both or neither.

# Resolve the Kurtosis CLI: pinned .tools copy first (README says scripts prefer
# it), then PATH (README also documents brew/PATH installs as supported).
resolve_kurtosis() {
  local root="$1"
  local candidate
  for candidate in "${root}/.tools/kurtosis/kurtosis" "${root}/.tools/kurtosis/kurtosis.exe"; do
    if [[ -x "$candidate" || -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  if candidate="$(command -v kurtosis 2>/dev/null)"; then
    echo "$candidate"
    return 0
  fi
  echo "Kurtosis CLI not found in ${root}/.tools/kurtosis/ or on PATH - see README / docs/GPU-EVIDENCE-RUNBOOK.md" >&2
  return 1
}

# The package is uploaded from the current filesystem. Reject indirection and
# record a deterministic digest so the bytes handed to Kurtosis are explicit.
require_kurtosis_sources() {
  local root="$1"
  [[ -f "$root/package/main.star" && -f "$root/package/kurtosis.yml" ]] || {
    echo "Kurtosis package sources are incomplete under $root/package" >&2
    return 1
  }
  local symlink digest
  symlink="$(find "$root/package" "$root/scripts" -type l -print -quit)"
  [[ -z "$symlink" ]] || {
    echo "Kurtosis source symlinks are forbidden: $symlink" >&2
    return 1
  }
  digest="$(node "$root/scripts/source-manifest.mjs" "$root")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf 'Kurtosis source manifest: %s\n' "$digest"
}

# Destructive enclave reuse is opt-in. A fixed enclave name is shared with any
# other developer/job on this host; removing it discards their logs.
# Usage: prepare_enclave <kurtosis-bin> <name> <replace:0|1>
prepare_enclave() {
  local kurtosis="$1" name="$2" replace="$3"
  if "$kurtosis" enclave inspect "$name" >/dev/null 2>&1; then
    if [[ "$replace" != "1" ]]; then
      {
        echo "Enclave '${name}' already exists."
        echo "Re-run with --replace to destroy and recreate it, or pick another name:"
        echo "  ZKDEAL_ENCLAVE=<name> $0"
        echo "Its logs can be preserved first with: ${kurtosis} enclave dump ${name} <dir>"
      } >&2
      return 1
    fi
    echo "==> removing existing enclave '${name}' (--replace)"
    "$kurtosis" enclave rm "$name" --force
  fi
}
