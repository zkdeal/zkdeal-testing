import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Abi, Hex } from 'viem'
import { root } from './runner-env.ts'

/// Loading the Foundry build products the acceptance run deploys and calls.

export type Artifact = {
  abi: Abi
  bytecode: { object: Hex }
  deployedBytecode?: { object: Hex }
  source: string
}

/// Foundry writes `out/<File>.sol/<Name>.json` or `out/src/<File>.sol/<Name>.json`
/// depending on whether the build targeted one file or the whole project, so
/// every load tries both spellings instead of only the room manager's.
function artifactCandidates(relative: string): string[] {
  const prefix = 'web3-protocol/contracts/out/'
  return relative.startsWith(prefix)
    ? [relative, relative.replace(prefix, `${prefix}src/`)]
    : [relative]
}

export async function artifact(relative: string): Promise<Artifact> {
  const failures: string[] = []
  for (const candidate of artifactCandidates(relative)) {
    const path = resolve(root, candidate)
    try {
      const loaded = JSON.parse(await readFile(path, 'utf8')) as Artifact
      return { ...loaded, source: relative }
    } catch (error: unknown) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `the Solidity artifact ${relative} is unavailable; ${failures.join('; ')}`,
  )
}
