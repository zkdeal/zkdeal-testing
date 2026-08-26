import { describe, expect, it } from 'vitest'

import { humanErrorReport, humanText } from './human-report.mts'

describe('human error reports', () => {
  // The prospects reporter these scripts used to import sets
  // `blockers: context.blocker || message`, so a static blocker discarded the
  // real error entirely and a multi-stage script reported nothing useful.
  it('keeps the thrown message as the evidence line', () => {
    const report = humanErrorReport(
      {
        task: 'RTX 4090 capacity request preparation',
        decision: 'Capacity sweep requests were not prepared',
        blocker: 'A required prover image ID, source artifact, or CPU validation step is unavailable.',
      },
      new Error('capacity fixture generation: ZKDEAL_PROGRAM_ID must be the current non-zero RISC Zero image ID'),
    )
    expect(report.evidence).toContain('capacity fixture generation')
    expect(report.evidence).toContain('ZKDEAL_PROGRAM_ID')
    expect(report.blocker).toBe(
      'A required prover image ID, source artifact, or CPU validation step is unavailable.',
    )
  })

  it('reports a non-Error rejection without losing it', () => {
    expect(humanErrorReport({ task: 'anything' }, 'plain rejection').evidence).toBe('plain rejection')
  })

  // Every script that renders through this module gets the same redaction; the
  // point of routing the inline reporters here is that the guarantee stops
  // depending on which script ran.
  it('redacts credential URLs and full EVM identifiers', () => {
    expect(humanText('see https://prover.example/6ff2a1secret for the run')).toContain(
      'https://prover.example/[credential-hidden]',
    )
    expect(humanText('deployed 0x1111111111111111111111111111111111111111')).toBe('deployed 0x1111...1111')
  })
})
