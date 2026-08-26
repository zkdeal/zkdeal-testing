const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const CREDENTIAL_URL = /(https?:\/\/[^/\s]+\/)[^\s/?#]+/giu
const FULL_EVM_IDENTIFIER = /\b0x[a-fA-F0-9]{40,}\b/gu

export interface HumanReport {
  subject?: string
  decision: string
  evidence: string
  blocker?: string
  nextAction: string
  artifact: string
  resourceBudget?: string
}

export function humanText(value: unknown): string {
  return String(value ?? '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(CREDENTIAL_URL, '$1[credential-hidden]')
    .replace(FULL_EVM_IDENTIFIER, (identifier) => `${identifier.slice(0, 6)}...${identifier.slice(-4)}`)
    .replace(/\s+/gu, ' ')
    .trim()
}

export function writeHumanReport(report: HumanReport, stream: NodeJS.WriteStream = process.stdout): void {
  const lines: string[] = []
  if (report.subject) lines.push(`Subject: ${humanText(report.subject)}`)
  lines.push(`Decision: ${humanText(report.decision)}`)
  lines.push(`Evidence: ${humanText(report.evidence)}`)
  lines.push(
    `Blocker: ${humanText(report.blocker ?? 'None at the completed decision boundary.')}`,
  )
  lines.push(`Next action: ${humanText(report.nextAction)}`)
  lines.push(`Evidence saved: ${humanText(report.artifact)}`)
  lines.push(
    `Resource budget: ${humanText(report.resourceBudget ?? 'Not supplied for this command.')}`,
  )
  stream.write(`${lines.join('\n')}\n`)
}

export interface HumanErrorContext {
  task: string
  decision?: string
  blocker?: string
  nextAction?: string
  artifact?: string
}

// The thrown message becomes the Evidence line rather than being replaced by
// the static blocker, so the operator learns which stage and which invariant
// failed instead of only that something did.
export function humanErrorReport(context: HumanErrorContext, error: unknown): HumanReport {
  return {
    subject: context.task,
    decision: context.decision ?? 'The requested command did not complete.',
    evidence: error instanceof Error ? error.message : String(error),
    blocker: context.blocker,
    nextAction: context.nextAction ?? 'Resolve the blocker and run the command again.',
    artifact: context.artifact ?? 'No artifact was written.',
  }
}

// Top-level handlers for scripts that run as a bare module body.
export function installHumanErrorHandlers(context: HumanErrorContext): void {
  const report = (error: unknown): void => {
    writeHumanReport(humanErrorReport(context, error), process.stderr)
    process.exitCode = 1
  }
  process.on('uncaughtException', report)
  process.on('unhandledRejection', report)
}

export function writeHumanFailure(
  subject: string,
  effect: string,
  recovery: string,
  artifact: string,
): void {
  writeHumanReport(
    {
      subject,
      decision: 'The requested check did not complete.',
      evidence: 'No machine payload or provider response was printed.',
      blocker: effect,
      nextAction: recovery,
      artifact,
    },
    process.stderr,
  )
}
