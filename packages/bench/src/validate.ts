import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { writeHumanFailure, writeHumanReport } from '../../../scripts/lib/human-report.mts'
import { validateEvidence } from './evidence.ts'

const artifactPath = resolve(
  process.argv[2] ?? process.env.OUT_PATH ?? '/out/v5-kurtosis-evidence.json',
)

async function validate(): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(artifactPath, 'utf8'))
  } catch {
    throw new Error('the acceptance evidence file is unreadable or is not JSON')
  }
  const problems = validateEvidence(parsed)
  if (problems.length > 0) {
    throw new Error(`the acceptance evidence is not publishable: ${problems.join('; ')}`)
  }
  writeHumanReport({
    subject: 'Long-lived room acceptance evidence gate',
    decision: 'The emitted evidence file carries a complete workload and device provenance.',
    evidence:
      'Workload descriptor, prepare request, GPU identity and the granted and denied role checks are all present.',
    nextAction: 'Publish the artifact or attach it to the release record.',
    artifact: artifactPath,
  })
}

validate().catch((error: unknown) => {
  writeHumanFailure(
    'Long-lived room acceptance evidence gate',
    error instanceof Error ? error.message : 'unknown failure',
    'Rerun the Kurtosis acceptance runner and gate the freshly emitted artifact.',
    artifactPath,
  )
  process.exitCode = 1
})
