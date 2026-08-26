import { describe, expect, it } from 'vitest'
import { pickSegmentPo2, SEGMENT_PO2_BANDS, ALLOWED_PO2 } from './pick-segment-po2.mjs'

describe('pickSegmentPo2', () => {
  it('gives the measured 8 GB laptop card PO2 19', () => {
    // RTX 3080 Laptop, 8192 MiB - proven in this repo (peaks ~6.1 GB at 19).
    expect(pickSegmentPo2(8192).po2).toBe(19)
  })

  it('gives measured 24 GB+ cards PO2 20', () => {
    expect(pickSegmentPo2(24 * 1024).po2).toBe(20) // RTX 4090
    expect(pickSegmentPo2(80 * 1024).po2).toBe(20) // H100 / A100 80 GB
    expect(pickSegmentPo2(183 * 1024).po2).toBe(20) // B200 ~180 GB
  })

  it('keeps a 12 GB card at PO2 20 and a 10 GB card at 19', () => {
    expect(pickSegmentPo2(12 * 1024).po2).toBe(20)
    expect(pickSegmentPo2(10 * 1024).po2).toBe(19)
  })

  it('drops a sub-8 GB card to the best-effort PO2 18', () => {
    expect(pickSegmentPo2(6 * 1024).po2).toBe(18)
  })

  it('is monotonic: more VRAM never picks a smaller segment', () => {
    let previous = 0
    for (let gib = 1; gib <= 200; gib++) {
      const po2 = pickSegmentPo2(gib * 1024).po2
      expect(po2).toBeGreaterThanOrEqual(previous)
      previous = po2
    }
  })

  it('only ever picks an accepted PO2 value', () => {
    for (let gib = 1; gib <= 200; gib++) {
      expect(ALLOWED_PO2).toContain(pickSegmentPo2(gib * 1024).po2)
    }
  })

  it('fails closed on a non-positive or unparseable VRAM', () => {
    expect(() => pickSegmentPo2(0)).toThrow()
    expect(() => pickSegmentPo2(-1)).toThrow()
    expect(() => pickSegmentPo2(Number.NaN)).toThrow()
  })

  it('bands are ordered high-to-low so the highest match wins', () => {
    for (let i = 1; i < SEGMENT_PO2_BANDS.length; i++) {
      expect(SEGMENT_PO2_BANDS[i - 1]!.minVramGiB).toBeGreaterThan(SEGMENT_PO2_BANDS[i]!.minVramGiB)
    }
    expect(SEGMENT_PO2_BANDS[SEGMENT_PO2_BANDS.length - 1]!.minVramGiB).toBe(0)
  })
})
