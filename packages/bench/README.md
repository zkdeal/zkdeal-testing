# zkdeal acceptance runner

This package contains only the long-lived-room Kurtosis acceptance runner.
It requests fresh CUDA proofs, deploys the official RISC Zero verifier and the
room contracts to the local Kurtosis L1, submits the proved batch, and
checks the accepted terminal state.

The runner is normally started by `kurtosis/main.star`, which runs
`pnpm exec tsx src/kurtosis-runner.ts` inside the coordinator image with the
environment already set. Running it by hand needs the same environment and a
reachable Kurtosis L1 and CUDA prover:

```text
L1_RPC_URL=<kurtosis l1 rpc>     required; the run stops immediately without it
PROVER_URL=<cuda prover>         default http://risc0-cuda-prover:8080
DEPLOYER_KEY=<0x-prefixed key>   default is the devnet funder key
APP_ROOT=<repo root in image>    default /app; where contracts/out is read from
OUT_PATH=<evidence file>         default /out/v5-kurtosis-evidence.json
GPU_NAME=<declared device>       optional label; must match the prover's device
PROOF_SAMPLES=<count>            default 3 measured room proofs after warm-up
RUNNER_TIMEOUT_SECONDS=<seconds> default 2700; keep it equal to the enclave wait
```

```text
pnpm --filter @zkdeal/bench kurtosis:run
```

The command prints a short human decision plus one redacted progress line per
phase on stderr. Full receipts, addresses, hashes, transactions, gas data and
failure details are written only to the configured machine-evidence file. CPU
proving and development receipts are rejected.

`RUNNER_TIMEOUT_SECONDS` is the run's own deadline. It must stay at or below the
enclave's `runner_timeout`, because a run killed by Kurtosis writes no evidence
at all; ninety percent of it is the point at which the runner gives up and
writes a structured failure instead.

`PROOF_SAMPLES` sizes the timing evidence. Three samples describe a median, not
a tail: the calibration block reports `supportsTailClaim: false` below twenty
samples, and the advertised slot target and room deadline are both derived from
the measured maximum plus the margin recorded in `gpuCalibration.safetyFactors`.

Gate the emitted artifact before publishing or comparing it:

```text
pnpm --filter @zkdeal/bench validate <path-to-v5-kurtosis-evidence.json>
```

The gate fails any artifact that carries timing numbers without the workload
descriptor, the literal prepare request, the prover-reported device identity
and the prover image id needed to re-derive and attribute them, or that cannot
show which accounts were denied administrative power.

`src/kurtosis-runner.ts` is the entry point and holds the orchestration, the
measured proving phase and the emitted evidence. The phases it drives live
beside it, one file per responsibility:

```text
runner-env.ts       environment, run budget, redacted progress channel
artifacts.ts        Foundry artifact loading
prover-client.ts    the CUDA prover HTTP boundary and its response shapes
chain-ops.ts        role accounts, deployment and write helpers, assertions
deployment.ts       the contract set and the cold template registration
pool-lifecycle.ts   pool identifiers, state reads, configuration and upgrade
room-lifecycle.ts   room reservation, start and proved batch submission
settlement.ts       allocation drain, fee claims and role separation
journal.ts          the guest journal mapped onto the L1 batch tuple
evidence.ts         pure statistics, guards and the publication gate
card-readiness.ts   whether this image can prove a hidden-card duel locally
```

## The hidden-card duel

The coordinator also hosts `/card-duel`, the one demonstration of
confidentiality in the product: the browser generates the inner Groth16 proofs,
so the coordinator never sees a deck order, a salt or a hand. That needs about
25.6 MB of circom wasm and Groth16 zkey per stand, and `circuits/build/*` is
gitignored while `scripts/build-circuits.sh` builds only the settle circuit. So
the artifacts exist in an image only when someone ran
`pnpm --filter @zkdeal/circuits build:card` first.

`card-readiness.ts` decides which of the two happened by hashing what is on
disk against `circuits/card-artifacts.lock.json` - the same trust root the
browser checks its downloads against - and records the verdict as `cardDuel` in
the evidence file. `kurtosis/main.star`'s `report-card-duel-readiness` step
prints it at startup, so an operator learns it before a visitor does.

A missing card artifact is **not** an acceptance failure and does not fail the
enclave: the room, the CUDA proof and the L1 transition are valid evidence
without it, and only the `/card-duel` route is degraded. The keys are
uncontributed demo keys in either case; `ceremony` travels into the evidence
verbatim, because anyone holding a zkey can forge a proof of any statement of
the circuit and every screen claiming confidentiality has to say so.

The former v4 benchmark and network-fault harness was removed. It is not a
supported or callable compatibility surface.
