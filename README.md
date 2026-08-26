# kurtosis-testing

This folder is where the project's claims become falsifiable. One Starlark
package (`package/main.star`) stands up the whole system against a real local
Ethereum: an ethereum-package geth/Lighthouse devnet, a digest-pinned
Blockscout, the CUDA prover, and the coordinator - then a blocking bootstrap
deploys the room contracts and submits a fresh two-block Groth16 proof before
anything is called ready. The bench runner (`packages/bench`) drives the
lifecycle and emits an evidence artifact; `validate` gates it. Success is
binary and machine-checked: the evidence `decision` must equal `VERIFIED`
and the checkpoint submit transaction must be indexed by Blockscout - blocks
with real proofs visibly landing on L1, or a named failure.

The same discipline extends to what may be *said* afterwards.
`docs/GPU-EVIDENCE-RUNBOOK.md` is the policy separating a green integration
gate from publishable benchmark evidence: clean-checkout requirements,
no-retry receipts, dirty-tree results marked diagnostic-only, and a
benchmark matrix that must never become a push gate.
`scripts/check-gpu-workflows.mjs` mechanically guards that the GPU release
path keeps these properties - the required workflow shape, the CUDA-only
package, the enclave-preserving runner pair.

Honesty note: the full end-to-end run has not yet been executed green on the
current split layout on this machine. Treat `e2e` as the acceptance target
the folder defines, not as an established local result; the dated evidence
that does exist is linked from `book/docs/status/`.

## Quickstart

Docker Desktop must be running. `guards-test` and `bench-test` are GPU-free;
`e2e` requires an NVIDIA GPU with container GPU support and builds the full
image set first.

```bash
cd kurtosis-testing
docker compose run --rm guards-test   # workflow-shape guard + script unit tests
docker compose run --rm bench-test    # bench runner unit tests
docker compose run --rm e2e           # full acceptance: L1 + prover + coordinator + Blockscout
```

`e2e` wraps `scripts/run-kurtosis-test.*`; running the Kurtosis CLI natively
on the host (resolved from `.tools/kurtosis/` or `PATH`) is the documented
alternative. Kurtosis uploads the package via git, so every file under this
folder must be tracked - the runners refuse to start otherwise. Evidence
lands under `test-results/` (gitignored by policy; the guard asserts the
ignore rule).

The prover's `SEGMENT_PO2` is chosen from the node's GPU VRAM automatically at
build time (an 8 GB card must run a smaller segment than a 24 GB one, or the
Groth16 wrap OOMs and produces no proof). Override it with `ZKDEAL_SEGMENT_PO2`.
See [docs/GPU-SEGMENT-SIZING.md](docs/GPU-SEGMENT-SIZING.md) for the table, the
reasoning, and how to set it by hand.

## Finality in acceptance evidence

A syntactically valid transaction hash or a one-confirmation receipt is not
publishable settlement evidence. The acceptance record retains the submit
block number and hash, re-reads the receipt, and compares that hash with the
canonical block at or below Ethereum's `finalized` checkpoint. Confirmation
depth may be recorded for diagnostics or an explicitly degraded provisional
run, but it never promotes evidence to final. A disappeared receipt is a reorg
signal and the identical settlement calldata is eligible for resubmission
while its journal deadline remains open.

Every enclave also carries an always-on Prometheus (host port 9090) and an
anonymous read-only Grafana (host port 3300), started before the bootstrap so
the 45-minute acceptance run can be watched live. See
[docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) for the full fixed-port map,
the scrape topology and the batching policy.

## How it connects

This folder consumes the others rather than linking them:

- **Reads** `web3-protocol/contracts/out/` - the bench deployment addresses
  every Foundry artifact through that literal path prefix - and resolves
  `web3-protocol/circuits` for card readiness reporting;
- **Writes** the re-minted real-proof fixture back into
  `web3-protocol/contracts/test/fixtures/`;
- **Builds images** from siblings: the prover from
  `prover-node/zkvm/docker/risc0-cuda.Dockerfile`, the coordinator from
  `web2-api/server/Dockerfile` (umbrella root as build context);
- **Guards** `.github/workflows/{ci,gpu-ci}.yml` at the umbrella root - the
  one location the folder split could not relocate - via
  `scripts/check-gpu-workflows.mjs`.

`book/` cites the evidence this folder produces; it consumes nothing from
here at build time.

## Layout

| Path | Contents |
| --- | --- |
| `package/` | The Starlark package: `main.star`, `tls.star`, `observability.star` (+ `observability/` Grafana provisioning), `kurtosis.yml`, `params/`. |
| `packages/bench` | `@zkdeal/bench`: the acceptance runner (`kurtosis:run`), deployment, lifecycle, prover client, evidence emission and the `validate` gate. |
| `scripts/` | `run-kurtosis-test.*`, `run-kurtosis-demo.*`, `demo-status/stop`, `build-docker-images.*`, `check-gpu-workflows.mjs` (+ its tests), `lib/` (shared runner + human-report helpers), `ops/`. |
| `docs/` | `GPU-EVIDENCE-RUNBOOK.md` (evidence policy; the guard reads it), `GPU-SEGMENT-SIZING.md` (VRAM → `SEGMENT_PO2` sizing), `OBSERVABILITY.md` (the always-on Prometheus + Grafana observers) and `KURTOSIS-STORY-PLAYER.md`. |
| `AUDIT-EXCEPTIONS.md` | Triaged dependency-advisory ledger for this folder's lockfile. |
