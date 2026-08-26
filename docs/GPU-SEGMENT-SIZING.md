# GPU segment sizing (`SEGMENT_PO2`)

Every prover node in this system runs one number that the rest of the stack
depends on: `SEGMENT_PO2`. This note explains what it is, why the value has to
match the node's GPU, the table the build uses to pick it automatically, and
how to set it by hand.

## Why this exists - the short version

The prover splits a room's execution into segments of `2^SEGMENT_PO2` cycles,
proves each segment on the GPU, then wraps the aggregate into a single Groth16
proof Ethereum can verify. `SEGMENT_PO2` is a **pure runtime memory/latency
knob** - it changes neither the guest program, the image id, nor the receipt a
verifier accepts. It only decides **how much VRAM a proof needs** and **how
fast it runs**.

Because it is runtime-only, each node may - and must - run the value its own
card can hold:

- **Too large for the card's VRAM** → the Groth16 wrap runs out of memory and
  **no proof is produced**. The node simply cannot prove; on a shared prove
  queue it leases work it can never complete.
- **Too small** → proving is needlessly slow (more, smaller segments). On this
  system a room checkpoint carries an **L1 inclusion deadline**: the proof must
  land in a bounded window of blocks or `submitBatch` reverts and the batch is
  **lost, not merely late**. A too-slow proof therefore fails checkpoints, it
  does not just delay them.

The prover fleet is intentionally heterogeneous - an 8 GB laptop through a
180 GB B200 - so **no single hardcoded value serves all of it**: `20` proves on
a 24 GB card but out-of-memories on 8 GB; `18` fits everywhere but throws away
the big cards' throughput and can miss deadlines. Hence per-node selection.

## The table

VRAM is the deciding axis, not the model name. Bands are keyed on total device
memory; the largest segment the band can hold is chosen.

| Total VRAM | `SEGMENT_PO2` | Basis |
| --- | --- | --- |
| ≥ 24 GB (RTX 4090/5090, A100, H100, B200) | **20** | Measured: all prove at 20 (4090 ≈ 63 s, H100 ≈ 38 s room proof; B200 recording images shipped `SEGMENT_PO2=20`) |
| 12 - 23 GB (RTX 3080 Ti/4070 Ti/…) | **20** | Interpolated: the ~4.8 GiB segment peak plus the Groth16 wrap fits; unmeasured, falls back to 19 if it OOMs |
| 8 - 11 GB (RTX 3080 Laptop, 3070) | **19** | Measured in this repo: RTX 3080 Laptop 8 GB peaks ~6.1 GB at 19 and **OOMs at 20** |
| < 8 GB | **18** | Best-effort: smallest segment to fit the wrap; untested, may still OOM |

Reference points behind the table (all at `SEGMENT_PO2=20` unless noted):

| GPU | VRAM | Room proof | Source |
| --- | --- | --- | --- |
| RTX 3080 Laptop | 8 GB | ~70-90 s at **PO2 19** (OOM at 20) | measured, this repo |
| RTX 4090 | 24 GB | ~63 s | measured (default-node floor) |
| A100 | 40-80 GB | ~62 s (1×) | measured |
| H100 | 80 GB | ~38 s (1×) | measured |
| B200 | ~180 GB | ~24 s (1×, derived) | measured config (recording images) |

The prover's own note records a **~4.8 GiB segment peak at PO2 20**; the extra
memory that sets the small-VRAM boundary is the Groth16 wrap layered on top.

### Why a 180 GB card gets the same value as a 24 GB card

`SEGMENT_PO2` is a **don't-run-out-of-memory floor, not a go-faster lever** for
this workload, so the table stops raising it once a card comfortably fits 20:

- **20 is the largest value measured good across the whole fleet, B200
  included** - the recording images shipped `SEGMENT_PO2=20`. Auto-selecting a
  bigger segment on a big card would be picking an *unvalidated* value, which is
  exactly the failure this feature prevents.
- **A room proof is a small workload.** At PO2 20 it is already only a handful
  of segments, so a bigger segment removes at most an aggregation step or two -
  a marginal, unmeasured gain. Segment size pays off on large executions; a
  two-block room batch is not one.
- **Big cards already win at the same PO2 from raw compute, not segment size:**
  H100 ≈ 38 s vs B200 ≈ 24 s, *both at PO2 20*. The B200's advantage is
  bandwidth and compute; enlarging its segment buys nothing here.

So more VRAM past ~12 GB does not make a single proof of this workload faster -
it buys **throughput** (more proofs in flight, more GPUs) at the same PO2.
`21` remains available as a **manual opt-in** for an operator who benchmarks a
large-VRAM card on their own workload and confirms it is actually faster; it is
deliberately not the automatic choice, which must be a value known to work.

## How the value is chosen automatically

`kurtosis-testing/scripts/build-docker-images.{sh,ps1}` probes the device with
`nvidia-smi --query-gpu=memory.total` and passes the VRAM to
`scripts/pick-segment-po2.mjs`, the single source of the table above. The
result is written into the generated Kurtosis params as `segment_po2`, which
`package/main.star` passes to the prover as `SEGMENT_PO2`.

The picker is pure and unit-tested (`scripts/pick-segment-po2.test.ts`); it can
also be run by hand for any card:

```bash
node kurtosis-testing/scripts/pick-segment-po2.mjs 8192 "RTX 3080 Laptop"
# -> 19   (and prints the reason to stderr)
```

## Setting it manually

An explicit value always wins over the automatic choice. Set it when you know
your card better than the table does (for example, to push a large-VRAM card to
a bigger segment for speed, or to drop a 12-16 GB card that OOMs at 20):

```bash
# Local Kurtosis acceptance / demo (bash or PowerShell):
ZKDEAL_SEGMENT_PO2=19 pnpm -C kurtosis-testing kurtosis:test
ZKDEAL_SEGMENT_PO2=19 pnpm -C kurtosis-testing demo:start
```

```powershell
$env:ZKDEAL_SEGMENT_PO2 = '19'; pnpm -C kurtosis-testing kurtosis:test
```

Accepted values are `18`, `19`, `20`, `21`. For a prover run outside Kurtosis,
set `SEGMENT_PO2` directly on the `zkdeal-r0` container:

```bash
docker run --gpus all -e SEGMENT_PO2=19 -e RISC0_REQUIRE_CUDA=1 \
  zkdeal-risc0-cuda-runtime serve --host 0.0.0.0 --port 8080
```

If a node OOMs at the chosen value, drop `SEGMENT_PO2` by one and retry; if a
large-VRAM node has spare memory and you want more speed, raise it by one and
confirm it still proves before relying on it.
