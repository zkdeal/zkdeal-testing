# Kurtosis story player

The web app exposes the replayable node view at `/kurtosis`. The page includes all six required recovery stories and all twelve required adversary stories, with play/pause, event stepping, scrubbing, and 0.25×-2× playback.

The player distinguishes two data modes:

- **Protocol reference** is the checked-in, explicitly unmeasured explanation. Its timings are illustrative.
- **Measured run** is loaded from a story-trace file emitted alongside a benchmark run's scenario envelopes. No checked-in runner produces one today, so the measured mode has no current producer; the player imports whatever trace file you hand it and badges the protocol version that file declares.

Open `/kurtosis`, choose **Load run trace**, and select one or more trace files. Loading H100, RTX 4090, and 30-series traces together adds aligned timing bars; switching the run changes node/event timing, GPU identity, hashes, signatures, L1 slots/blocks, and observed scenario evidence.

The trace schema is `zkdeal-kurtosis-stories/v1`. It carries:

- the 16-service bench topology (15 persistent services plus the one-shot runner), with the room manager drawn separately as a contract. Live enclaves additionally run the `prometheus` and `grafana` observers, which sit outside the recorded trace topology;
- immutable run identity, GPU/CUDA/RISC Zero identity, and canonical-run median timing source;
- one event timeline per required story;
- actors, targets, L2 blocks and roots, approval identities/digests/signatures, proof/seal telemetry, L1 block contents, and result status where the run recorded them;
- global and story-specific assumptions, guarantees, and explicit non-guarantees.

The rendition is embeddable as a normal React component:

```tsx
import { KurtosisStoryPlayer } from '@/components/kurtosis-story-player'

export default function ProtocolEvidencePage() {
  return <KurtosisStoryPlayer />
}
```

Scenario chronology comes from each exact raw scenario envelope. Until runtime endpoints emit per-event timestamps, recovery/adversary stage widths use the same run's measured canonical median profile and are labeled `measured-canonical-median`; they are not presented as scenario-specific latency measurements.
