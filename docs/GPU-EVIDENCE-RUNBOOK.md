# zkdeal GPU integration and benchmark evidence

The GPU pipeline is intentionally split into two jobs with different claims and time budgets. A green integration gate is not benchmark publication evidence.

## Required six-test integration gate

`.github/workflows/gpu-ci.yml` runs on trusted pull requests, pushes to `main`, and explicit dispatches. Configure its stable `GPU release gate (required)` result as a required branch-protection check.

The job assigns `zkdeal-test-<run-id>-<attempt>` and runs `pnpm kurtosis:test` on the registered RTX 4090 runner. It never uses replacement mode, so a rerun cannot erase a prior failed enclave. It requires a clean checkout, immutable RISC Zero toolchain/runtime image digests, `RISC0_DEV_MODE=0`, an idle CUDA GPU, no CPU fallback, reproducible reviewed artifacts, and `PLAYWRIGHT_RETRIES=0`. The stored JUnit report must contain exactly six passing tests with no failures, errors, skips, or retries:

1. CUDA-only prover capabilities.
2. A real two-block AMM seal accepted by the room manager, with the exact `BatchVerified` receipt and Lighthouse slot match.
3. Proven member activation/retirement and a frozen retired balance.
4. Real-L1 rejection of a forged seal and altered calldata.
5. A real vault seal accepted by the deployed adapter and upstream RISC Zero verifier.
6. A real card seal accepted by the deployed adapter and upstream RISC Zero verifier.

The integration job has a 12-hour ceiling. This allows the intentionally generous two-hour proof request deadlines and stack/image setup without pretending to execute the publication matrix. Its artifact contains JUnit, validation summary, generated test parameters, deployment addresses, source/image provenance, logs, and the zkVM trust-root lock.

Passing this job supports a narrowly scoped real CUDA/L1 validity-integration claim. It does not establish the AMM N-to-N+1 latency target, the 95/100 gate, p99, WAN performance, or benchmark economics.

## Manual/scheduled publication-scale benchmark

A publication-scale benchmark is a manual or scheduled run only. It must never be a pull-request or push gate and must never be required by branch protection. The dedicated workflow and its `pnpm kurtosis:bench` runner are not currently checked in; this section is the policy any future benchmark run has to meet before its numbers may be published.

Such a run assigns `zkdeal-bench-<run-id>-<attempt>` and never uses replacement mode, using this benchmark policy:

- five warmups;
- exactly 100 primary attempts and at least 95/100 successes;
- exactly 1,000 independent canonical attempts before p99 can be reported;
- 100 attempts in each 2/5/7-member × LAN/50/120 ms × 0/1% loss cell, for 1,800 matrix attempts;
- all lifecycle, restart/recovery, and adversarial scenarios required by the existing publication gate;
- timeouts retained as failures, with no retry, trimming, or cherry-picking path.

The Kurtosis benchmark runner has 72 hours. The self-hosted job has 96 hours so image builds, network startup, result validation, and evidence upload do not consume the runner’s measurement budget. This remains below the platform’s five-day self-hosted job limit.

A benchmark run validates the gate above without changing its 100-attempt denominator, zero-mismatch rules, p99 threshold, correctness matrix, lifecycle comparison, or scenario assertions. It uploads evidence for review but never promotes a result and never edits a published evidence record.

## Clean and dirty source policy

Every GPU workflow requires an exact clean checkout. The evidence validator independently rejects `identity.dirtyTree=true` with the message that dirty source trees are diagnostic-only.

Local operators may run either command from a dirty tree for diagnosis, provided `ZKDEAL_SOURCE_DIRTY=true` is recorded. Such results are explicitly non-publishable: they must not be copied into a published evidence record, cited in a claim, or compared as release evidence. Never relabel a dirty snapshot as clean.

## Local commands

Set the immutable toolchain/runtime image pins and a positive operator GPU reservation cost, then run one mode at a time:

```powershell
$env:RISC0_PROVER = 'local'
$env:RISC0_DEV_MODE = '0'
$env:ZKDEAL_RISC0_TOOLCHAIN_IMAGE = 'sha256:<reviewed-toolchain-id>'
$env:ZKDEAL_RISC0_RUNTIME_IMAGE = 'sha256:<reviewed-runtime-id>'
$env:ZKDEAL_GPU_USD_PER_HOUR = '1'

$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$env:ZKDEAL_ENCLAVE = "zkdeal-test-local-$Stamp"
pnpm kurtosis:test
```

A multi-day publication-scale benchmark has no checked-in runner today. Reinstating one means restoring both the runner and the policy above in the same change.

Run each gate in a fresh, unique enclave. Do not re-run a failed Playwright test in place: zero retries are part of acceptance. On failure, the runner best-effort preserves enclave inspection, all-service logs, and an enclave dump before returning the original nonzero exit code. They never auto-delete evidence enclaves. Do not use replacement mode until that evidence has been independently preserved and reviewed. Do not use a CPU prover, mock verifier, Docker prune, or an unreviewed image rebuild as recovery.

Integration evidence is written under `test-results/v5-gpu-integration/`. The workflow uploads are review inputs, not automatic publication.

## Promotion

After a complete clean benchmark run:

1. Review raw primary, p99, matrix, lifecycle, recovery, adversary, GPU, L1, and image/source provenance.
2. Re-run `pnpm --filter @zkdeal/bench validate <evidence.json>` on the immutable download.
3. Obtain explicit review approval.
4. Only then record the result in a dated evidence file under `docs/evidence/`.

Failures, partial matrices, killed jobs, dirty-tree runs, and integration-only JUnit artifacts remain diagnostic evidence and cannot be promoted.
