#!/usr/bin/env node
/**
 * Pick a RISC Zero `SEGMENT_PO2` for the CUDA prover from the node's GPU VRAM.
 *
 * WHY THIS EXISTS - read before changing the table.
 *
 * The prover segments the guest execution into chunks of 2^PO2 cycles and
 * proves each on the GPU, then wraps the aggregate STARK into a Groth16 SNARK
 * for Ethereum. PO2 is a pure runtime memory/latency knob: it changes neither
 * the guest ELF, the image id, nor the receipt a verifier accepts - only how
 * much VRAM a proof needs and how fast it runs. Larger PO2 = fewer, bigger
 * segments = faster, but more VRAM per segment AND a heavier Groth16 wrap.
 *
 * Get it wrong in either direction and the node cannot do its job:
 *   - Too large for the card's VRAM: the Groth16 wrap runs out of memory and
 *     NO proof is produced. The node silently cannot participate.
 *   - Too small: proving is needlessly slow (more segments). On this system a
 *     room checkpoint carries an L1 inclusion deadline, so a slow proof misses
 *     its block and `submitBatch` reverts - the batch is lost, not merely late.
 *
 * The prover fleet is deliberately heterogeneous - an 8 GB laptop through a
 * 180 GB B200 - so one hardcoded PO2 cannot serve all of it: 20 proves on a
 * 24 GB card but OOMs on 8 GB; 18 fits everywhere but wastes the big cards'
 * throughput and can miss deadlines. Hence: pick the largest PO2 the card's
 * VRAM can hold, per node.
 *
 * MEASUREMENTS behind the table (VRAM is the deciding axis, not the model):
 *   - RTX 3080 Laptop, 8 GB   : PO2 19 proves (full-flow peak ~6.1 GB); PO2 20 OOMs.  [measured, this repo]
 *   - RTX 4090, 24 GB         : PO2 20, ~63 s room proof.                              [measured]
 *   - A100 / H100, 40-80 GB   : PO2 20, ~62 s / ~38 s room proof.                      [measured]
 *   - B200, ~180 GB           : PO2 20 (recording images shipped SEGMENT_PO2=20).      [measured config]
 * The prover's own note records a ~4.8 GiB *segment* peak at PO2 20; the extra
 * memory that decides the small-VRAM boundary is the Groth16 wrap on top.
 *
 * Bands are keyed on total VRAM in GiB. The 8-11 and >=12 boundaries are
 * measured; <8 and 12-23 are interpolated (marked below) and default toward
 * the safe, smaller segment. Override any node explicitly with
 * ZKDEAL_SEGMENT_PO2 (see kurtosis-testing/docs/GPU-SEGMENT-SIZING.md).
 *
 * Usage:  node pick-segment-po2.mjs <total_vram_MiB> [gpu-name]
 *         -> prints the chosen PO2 (one of 18|19|20) to stdout.
 * Exit 2 on a missing/unparseable VRAM argument (callers fail closed rather
 * than substitute a guessed size).
 */

/** VRAM bands (GiB, inclusive lower bound) -> SEGMENT_PO2. Highest match wins. */
export const SEGMENT_PO2_BANDS = Object.freeze([
  // vramGiB is the minimum total VRAM for this band.
  { minVramGiB: 12, po2: 20, basis: 'measured >=24 GB (4090/A100/H100/B200 @ 20); 12-23 GB interpolated' },
  { minVramGiB: 8, po2: 19, basis: 'measured: RTX 3080 Laptop 8 GB peaks ~6.1 GB at 19, OOMs at 20' },
  { minVramGiB: 0, po2: 18, basis: 'best-effort for <8 GB: smallest segment to fit the Groth16 wrap (untested)' },
])

/** The PO2 values main.star and the params validator accept. */
export const ALLOWED_PO2 = Object.freeze([18, 19, 20, 21])

/**
 * @param {number} vramMiB total device memory in MiB (nvidia-smi memory.total)
 * @returns {{ po2: number, basis: string, vramGiB: number }}
 */
export function pickSegmentPo2(vramMiB) {
  if (!Number.isFinite(vramMiB) || vramMiB <= 0) {
    throw new Error(`VRAM must be a positive number of MiB, got ${JSON.stringify(vramMiB)}`)
  }
  const vramGiB = vramMiB / 1024
  const band = SEGMENT_PO2_BANDS.find((b) => vramGiB >= b.minVramGiB)
  // The last band has minVramGiB 0, so a match is guaranteed.
  return { po2: band.po2, basis: band.basis, vramGiB }
}

// CLI entry - only when run directly, so the table stays importable/testable.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (invokedDirectly || process.argv[1]?.endsWith('pick-segment-po2.mjs')) {
  const raw = process.argv[2]
  const vramMiB = Number(raw)
  if (!raw || !Number.isFinite(vramMiB) || vramMiB <= 0) {
    process.stderr.write(
      'usage: node pick-segment-po2.mjs <total_vram_MiB> [gpu-name]\n' +
        'A positive VRAM in MiB is required; refusing to guess a segment size.\n',
    )
    process.exit(2)
  }
  const gpuName = process.argv[3] ? ` (${process.argv[3]})` : ''
  const { po2, vramGiB } = pickSegmentPo2(vramMiB)
  process.stderr.write(`SEGMENT_PO2 auto-selected: ${po2} for ${vramGiB.toFixed(1)} GiB VRAM${gpuName}\n`)
  process.stdout.write(String(po2))
}
