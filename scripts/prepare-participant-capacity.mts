import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { writeHumanReport } from './lib/human-report.mts'

const root = resolve(import.meta.dirname, '..')
const evidence = resolve(
  process.env.ZKDEAL_CAPACITY_DIR
    ?? join(root, 'experiments', 'v5-participant-capacity-20260724'),
)
const requests = join(evidence, 'requests')
await mkdir(requests, { recursive: true })

const common = {
  deploymentDomain: `0x${'11'.repeat(32)}`,
  roomId: 7,
  l1ChainId: 31337,
  l1InclusionDeadline: 1000,
  touchedContracts: 1,
  residentAccounts: 2,
  residentMirrorVariables: 1,
  importedVariables: 0,
  stateCommitment: 'mpt',
}

const matrix = [
  ...[64, 128, 256].map((activeSigners) => ({
    id: `approvers-${activeSigners}`,
    class: activeSigners === 64 ? 'CERTIFICATION_CONFIRMATION' : 'EXPLORATORY',
    request: {
      ...common,
      authorizationMode: 'unanimous-approvers',
      activeSigners,
      participantCapacity: 128,
      registeredParticipants: 1,
      touchedParticipants: 1,
      workload: 'storage',
    },
  })),
  ...[1024, 32768].map((activeSigners) => ({
    id: `approvers-${activeSigners}`,
    class: 'EXPECTED_PROTOCOL_REJECTION',
    request: {
      ...common,
      authorizationMode: 'unanimous-approvers',
      activeSigners,
      participantCapacity: 128,
      registeredParticipants: 1,
      touchedParticipants: 1,
      workload: 'storage',
    },
  })),
  ...[128, 1024, 32768].map((participantCapacity) => ({
    id: `registered-${participantCapacity}-touched-1`,
    class: 'EXPLORATORY',
    request: {
      ...common,
      authorizationMode: 'validity-only',
      activeSigners: 0,
      participantCapacity,
      registeredParticipants: participantCapacity,
      touchedParticipants: 1,
      workload: 'participant-merkle',
    },
  })),
  ...[2, 8, 32, 128].map((touchedParticipants) => ({
    id: `registered-32768-touched-${touchedParticipants}`,
    class: 'EXPLORATORY',
    request: {
      ...common,
      authorizationMode: 'validity-only',
      activeSigners: 0,
      participantCapacity: 32768,
      registeredParticipants: 32768,
      touchedParticipants,
      workload: 'participant-merkle',
    },
  })),
]

for (const row of matrix) {
  await writeFile(join(requests, `${row.id}.json`), `${JSON.stringify(row.request, null, 2)}\n`)
}
await writeFile(
  join(evidence, 'matrix.json'),
  `${JSON.stringify(
    {
      format: 'zkdeal/v5-participant-capacity-matrix',
      generatedAt: new Date().toISOString(),
      measurementBoundary:
        'canonical signed batch and authenticated pre-state witness available through locally verified Groth16 receipt',
      rows: matrix.map(({ id, class: evidenceClass }) => ({
        id,
        evidenceClass,
        request: `requests/${id}.json`,
      })),
    },
    null,
    2,
  )}\n`,
)

writeHumanReport({
  decision: 'Participant and approver capacity requests are ready',
  evidence: `${matrix.length} bounded workloads cover both authorization modes.`,
  blocker: 'GPU proof latency and L1 submission limits are not measured by preparation.',
  nextAction: 'Run the matrix on the RTX 4090 and retain machine receipts in this directory.',
  artifact: evidence,
  resourceBudget: 'Preparation used no GPU and submitted no transaction.',
})
