import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { writeHumanFailure, writeHumanReport } from '../../../scripts/lib/human-report.mts'
import { validateExampleEvidence } from './example-evidence.ts'

const artifactPath = resolve(
  process.argv[2] ?? process.env.OUT_PATH ?? '/out/example-evidence.json',
)

async function validate(): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(artifactPath, 'utf8'))
  } catch {
    throw new Error('the example acceptance evidence file is unreadable or is not JSON')
  }
  const problems = validateExampleEvidence(parsed)
  if (problems.length > 0) {
    throw new Error(`the example acceptance evidence is not publishable: ${problems.join('; ')}`)
  }
  writeHumanReport({
    subject: 'Example demo-plane acceptance evidence gate',
    decision: 'The emitted evidence file carries a complete per-preset and fee provenance.',
    evidence:
      'Every preset in the case script has an L1 checkpoint transaction, the flow-fee delta matches its rate, and any queue block names live prover nodes.',
    nextAction: 'Publish the artifact or attach it to the enclave record.',
    artifact: artifactPath,
  })
}

validate().catch((error: unknown) => {
  writeHumanFailure(
    'Example demo-plane acceptance evidence gate',
    error instanceof Error ? error.message : 'unknown failure',
    'Rerun the example acceptance runner and gate the freshly emitted artifact.',
    artifactPath,
  )
  process.exitCode = 1
})
