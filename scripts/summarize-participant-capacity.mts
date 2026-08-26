import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { writeHumanReport } from './lib/human-report.mts'

type Proof = {
  cpuFallback: boolean
  proofMode: string
  gpuName: string
  vramSamplesMiB?: number[]
  cycles: number
  segments: number
  proofWork: {
    executedGas: number
    transactionCount: number
    encodedWitnessBytes: number
  }
  profile: { totalPipelineMs: number }
}

type Prepared = {
  measurement: {
    authorizationMode: string
    activeSigners: number
    registeredParticipants: number
    participantCapacity: number
    participantTreeDepth: number
    touchedParticipants: number
  }
}

type ControlPlaneMeasurement = {
  sampleCount: number
  admission: {
    p50Milliseconds: number
    p95Milliseconds: number
    maximumMilliseconds: number
    signedRequestBytes: number
    signedReceiptResponseBytes: number
  }
  observer: {
    roomSummaryBytes: number
    oneHundredAdmissionPageBytes: number
  }
  boundary: string
}

try {
  const root = resolve(
    process.argv[2] ??
      join(process.cwd(), 'experiments', 'v5-participant-capacity-20260724'),
  )
  const gpu = join(root, 'gpu')

  function percentile(values: number[], quantile: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.ceil(sorted.length * quantile) - 1]!
  }

  function seconds(value: number): string {
    return (value / 1000).toFixed(3)
  }

  const names = (await readdir(gpu, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

  const rows: Array<{
    name: string
    prepared: Prepared
    proofs: Proof[]
    cold: Proof
    canonicalBytes: number
  }> = []

  for (const name of names) {
  const directory = join(gpu, name)
  const files = (await readdir(directory)).filter((file) => /^measured-\d+\.json$/.test(file))
  if (files.length === 0) continue
  const prepared = JSON.parse(await readFile(join(directory, 'prepared.json'), 'utf8')) as Prepared
  const cold = JSON.parse(await readFile(join(directory, 'cold-proof.json'), 'utf8')) as Proof
  const roomRequest = JSON.parse(await readFile(join(directory, 'room-request.json'), 'utf8')) as {
    roomWitness?: {
      canonical_batch_data?: string | number[]
      canonicalBatchData?: string | number[]
    }
  }
  const canonicalData =
    roomRequest.roomWitness?.canonical_batch_data ??
    roomRequest.roomWitness?.canonicalBatchData ??
    ''
  const canonicalBytes =
    Array.isArray(canonicalData)
      ? canonicalData.length
      : /^0x[0-9a-fA-F]*$/.test(canonicalData) && canonicalData.length % 2 === 0
        ? (canonicalData.length - 2) / 2
        : 0
  const proofs = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8')) as Proof),
  )
  if (
    cold.cpuFallback ||
    cold.proofMode !== 'groth16' ||
    proofs.some((proof) => proof.cpuFallback || proof.proofMode !== 'groth16')
  ) {
    throw new Error(`${name} contains a non-CUDA or non-Groth16 result`)
  }
  rows.push({ name, prepared, proofs, cold, canonicalBytes })
  }

  if (rows.length === 0) {
    throw new Error('no measured CUDA proof files were found')
  }

  const controlPlane = JSON.parse(
    await readFile(join(root, 'control-plane.json'), 'utf8'),
  ) as ControlPlaneMeasurement
  const baseline = rows.find((row) => row.name === 'registered-128-touched-1')
  const largest = rows.find((row) => row.name === 'registered-32768-touched-1')
  const applicationRoot = resolve(root, '..', 'application-demos-4090-20260724')
  const l1Evidence = await Promise.all(
    ['shop', 'auction'].map(async (name) => {
      try {
        return JSON.parse(
          await readFile(join(applicationRoot, `kurtosis-${name}`, 'v5-kurtosis-evidence.json'), 'utf8'),
        ) as { decision?: string; gasUsed?: { submit?: string } }
      } catch {
        return null
      }
    }),
  )
  const l1Accepted = l1Evidence.every(
    (evidence) =>
      evidence?.decision === 'VERIFIED' &&
      BigInt(evidence.gasUsed?.submit ?? '0') > 0n &&
      BigInt(evidence.gasUsed?.submit ?? '0') < 30_000_000n,
  )
  const gpuMemoryObserved = rows.every((row) =>
    row.proofs.every(
      (proof) =>
        (proof.vramSamplesMiB?.length ?? 0) > 0 &&
        Math.max(...proof.vramSamplesMiB!) < 24_576,
    ),
  )
  const certified =
    baseline &&
    largest &&
    baseline.proofs.length === 20 &&
    largest.proofs.length === 20 &&
    percentile(
      largest.proofs.map((proof) => proof.profile.totalPipelineMs),
      0.95,
    ) <=
      percentile(
        baseline.proofs.map((proof) => proof.profile.totalPipelineMs),
        0.95,
      ) *
        1.2 &&
    gpuMemoryObserved &&
    l1Accepted

  const table = rows
  .map(({ name, prepared, proofs, cold, canonicalBytes }) => {
    const timing = proofs.map((proof) => proof.profile.totalPipelineMs)
    const proof = proofs[0]!
    const m = prepared.measurement
    const peakVram = Math.max(...proofs.flatMap((sample) => sample.vramSamplesMiB ?? [0]))
    return `| ${name} | ${m.activeSigners} | ${m.registeredParticipants} | ${m.touchedParticipants} | ${proof.proofWork.transactionCount} | ${proof.proofWork.executedGas.toLocaleString('en-US')} | ${proof.proofWork.encodedWitnessBytes.toLocaleString('en-US')} | ${canonicalBytes.toLocaleString('en-US')} | ${proof.cycles.toLocaleString('en-US')} | ${proof.segments} | ${peakVram.toFixed(0)} | ${seconds(cold.profile.totalPipelineMs)} | ${seconds(percentile(timing, 0.5))} | ${seconds(percentile(timing, 0.95))} | ${proofs.length} |`
  })
  .join('\n')

  const report = `# v5 participant and approver capacity on RTX 4090

## Decision

${certified ? 'The 32,768-registered-participant, one-touched-user configuration is hardware-certified against the 128-user baseline and accepted by the local Ethereum verifier.' : 'The matrix is exploratory. No new registered-participant capacity is certified until the 20-sample alternating and local-L1 gates pass.'}

Unanimous checkpoint approval remains capped at 256. The 1,024- and
32,768-approver requests were rejected before proving. Registered application
participants are a separate Merkle ledger; only touched paths contribute to
the batch workload.

## Direct CUDA measurements

The timer begins with the canonical signed batch and authenticated pre-state
witness available and ends after the Groth16 receipt passes local
verification. All rows use one RTX 4090, local CUDA proving, no CPU fallback,
two non-empty blocks, and a fresh cold-template proof saved separately.

| Case | Approvers | Registered | Touched | Transactions | EVM gas | Witness bytes | Public batch bytes | Cycles | Segments | Peak VRAM MiB | Cold seconds | p50 seconds | p95 seconds | Samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${table}

## Interpretation

- Audience size is not one free state variable. The root, epoch, count and
  capacity are fixed-size, but registration and every touched balance require
  an authenticated Merkle path.
- Untouched registered users add no checkpoint signatures and no per-batch
  path work.
- Touched-user count, transaction count, witness size and proof time remain
  measurable costs.
- Unanimous approvers additionally incur signature verification, Merkle
  proofs, calldata, L1 gas and an all-signers-online liveness dependency.
- A successful receipt proves state correctness. The operator still controls
  ordering and liveness; bonded admission and the L1 forced path address those
  separate risks.

## Admission and observer overhead

| Control-plane operation | Direct measurement |
| --- | ---: |
| Signed admission request | ${controlPlane.admission.signedRequestBytes.toLocaleString('en-US')} bytes |
| Signed receipt response | ${controlPlane.admission.signedReceiptResponseBytes.toLocaleString('en-US')} bytes |
| Admission p50 | ${controlPlane.admission.p50Milliseconds.toFixed(2)} ms |
| Admission p95 | ${controlPlane.admission.p95Milliseconds.toFixed(2)} ms |
| Room summary | ${controlPlane.observer.roomSummaryBytes.toLocaleString('en-US')} bytes |
| 100-admission observer page | ${controlPlane.observer.oneHundredAdmissionPageBytes.toLocaleString('en-US')} bytes |

The ${controlPlane.sampleCount}-sample admission measurement includes transaction
recovery, receipt signing, durable observer storage and response serialization.
It excludes network latency, proof generation and Ethereum inclusion.

## Evidence boundary

Machine receipts, seals, full identifiers and power samples remain in
\`gpu/\`. Public output and this report contain only decision-ready values.
The hardware-certified result additionally requires both application proofs
to be accepted by the local Ethereum verifier with submission gas below the
30-million-gas block target. GPU memory samples must remain below the physical
24 GiB device limit.
`

  await writeFile(join(root, 'RESULTS.md'), report, 'utf8')

  writeHumanReport({
    decision: certified
      ? '32,768 registered participants are certified for one touched user per two-block batch'
      : 'Capacity matrix is measured but not yet hardware-certified',
    evidence: `${rows.length} CUDA cases were summarized without CPU fallback.`,
    blocker: certified
      ? 'Certification applies only to the measured touched-user workload.'
      : 'The 20-sample alternating timing gate or local-L1 application gate has not passed.',
    nextAction: certified
      ? 'Measure larger touched-user batches and the L1 application checkpoint.'
      : 'Complete the alternating timing, GPU-memory, and local-L1 application gates.',
    artifact: join(root, 'RESULTS.md'),
    resourceBudget: 'One RTX 4090; Ethereum broadcast and inclusion excluded.',
  })
} catch (error) {
  // The thrown messages name the measurement directory, the file and the
  // invariant that failed. Reporting only the generic blocker discarded exactly
  // the information an operator needs after spending GPU hours.
  writeHumanReport(
    {
      decision: 'Capacity evidence could not be summarized',
      evidence: error instanceof Error ? error.message : String(error),
      blocker: 'A required measurement or local-verifier artifact is missing or invalid.',
      nextAction: 'Complete the CUDA suite and extract its machine evidence.',
      artifact: 'None',
      resourceBudget: 'No additional GPU or chain work was performed.',
    },
    process.stderr,
  )
  process.exitCode = 1
}
