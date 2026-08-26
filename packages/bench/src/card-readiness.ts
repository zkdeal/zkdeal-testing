import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { root } from './runner-env.ts'

/// Whether THIS enclave can host a hidden-card duel, decided by looking at the
/// filesystem rather than by assuming.
///
/// The card duel is the only demonstration of confidentiality in the product:
/// a browser proves deck initialization and every hand action locally, so the
/// coordinator never learns a deck order, a salt or a hand. That needs ~25.6 MB
/// of circom wasm and Groth16 zkey which `circuits/build/*` does not track
/// (.gitignore) and which `scripts/build-circuits.sh` does not produce - it runs
/// `build.mjs` (the settle circuit) and not `build-card.mjs`. So the artifacts
/// are present only when an operator ran
/// `pnpm --filter @zkdeal/circuits build:card` before the image was built.
///
/// A visitor must not discover that by clicking Prepare and collecting a 404
/// after a multi-megabyte download, and the stand must not claim local proving
/// it cannot do. This module answers the question once, at startup, from the
/// same trust root the browser uses - `circuits/card-artifacts.lock.json` - and
/// the answer travels into the evidence file so `kurtosis/main.star` can print
/// it and the operator can fix it before anyone is standing at the screen.
///
/// A missing artifact is NOT a failure of the acceptance run. The room, the
/// proof and the L1 transition are all valid without it; only the card demo is
/// degraded. So this reports and never throws.

/** File name inside the circuits root; the browser fetches this same document. */
const LOCK_FILE = 'card-artifacts.lock.json'
const LOCK_FORMAT = 'zkdeal/card-artifacts-lock/v4'

/// The kinds a client must have to PROVE. `vkey` is tracked, so a clean clone
/// can already verify a proof; wasm and zkey are what is actually at risk.
const PROVING_KINDS = ['wasm', 'zkey'] as const

type LockCircuit = {
  distribution?: Record<string, { path?: unknown; bytes?: unknown }>
  wasmSha256?: unknown
  demoZkeySha256?: unknown
}

export type CardArtifactStatus = {
  circuit: string
  kind: string
  path: string
  expectedBytes: number
  /** `null` when the file is absent. */
  actualBytes: number | null
  /** `true` only when the bytes on disk hash to the pinned digest. */
  matchesPin: boolean
  problem: string | null
}

export type CardDuelReadiness = {
  /** True only when every proving artifact is present AND matches its pin. */
  localProvingAvailable: boolean
  /** Uncontributed demo keys: anyone holding a zkey can forge a proof. */
  ceremony: string
  lockPath: string
  totalDownloadBytes: number
  artifacts: CardArtifactStatus[]
  /** One line an operator can act on; null when nothing is wrong. */
  remedy: string | null
  /** Why the check itself could not run, if it could not. */
  unavailable: string | null
}

const REMEDY =
  'run `pnpm --filter @zkdeal/circuits build:card` before `pnpm build:images`, then rebuild the coordinator image'

function digestField(kind: string): keyof LockCircuit {
  return kind === 'wasm' ? 'wasmSha256' : 'demoZkeySha256'
}

async function inspect(
  circuitsRoot: string,
  circuit: string,
  kind: string,
  entry: LockCircuit,
): Promise<CardArtifactStatus | null> {
  const file = entry.distribution?.[kind]
  if (!file || typeof file.path !== 'string' || typeof file.bytes !== 'number') return null
  const pinned = entry[digestField(kind)]
  const status: CardArtifactStatus = {
    circuit,
    kind,
    path: file.path,
    expectedBytes: file.bytes,
    actualBytes: null,
    matchesPin: false,
    problem: null,
  }
  const absolute = resolve(circuitsRoot, file.path)
  let size: number
  try {
    size = (await stat(absolute)).size
  } catch {
    return { ...status, problem: 'not built in this image' }
  }
  if (size !== file.bytes) {
    // Reported before the digest so a truncated copy is not misread as a
    // different file, which is the same order the browser checks in.
    return { ...status, actualBytes: size, problem: `is ${size} bytes, pinned at ${file.bytes}` }
  }
  if (typeof pinned !== 'string' || !/^[0-9a-f]{64}$/.test(pinned)) {
    return { ...status, actualBytes: size, problem: 'has no usable digest in the lock' }
  }
  const digest = createHash('sha256').update(await readFile(absolute)).digest('hex')
  if (digest !== pinned) {
    return { ...status, actualBytes: size, problem: 'does not match its pinned sha256' }
  }
  return { ...status, actualBytes: size, matchesPin: true }
}

/**
 * Decide whether this image can serve a browser everything it needs to prove a
 * card move locally. `circuitsRoot` defaults to the coordinator image layout.
 */
export async function cardDuelReadiness(
  circuitsRoot = resolve(root, 'web3-protocol', 'circuits'),
): Promise<CardDuelReadiness> {
  const lockPath = resolve(circuitsRoot, LOCK_FILE)
  const absent = (unavailable: string): CardDuelReadiness => ({
    localProvingAvailable: false,
    ceremony: 'unknown',
    lockPath,
    totalDownloadBytes: 0,
    artifacts: [],
    remedy: REMEDY,
    unavailable,
  })

  let lock: {
    format?: unknown
    ceremony?: unknown
    circuits?: Record<string, LockCircuit>
    browser?: { totalDownloadBytes?: unknown }
  }
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8')) as typeof lock
  } catch (error: unknown) {
    return absent(
      `the card artifact lock is unreadable at ${lockPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (lock.format !== LOCK_FORMAT) {
    return absent(`the card artifact lock declares format ${String(lock.format)}`)
  }
  const circuits = lock.circuits
  if (!circuits || typeof circuits !== 'object') {
    return absent('the card artifact lock declares no circuits')
  }

  const artifacts: CardArtifactStatus[] = []
  for (const [circuit, entry] of Object.entries(circuits)) {
    for (const kind of PROVING_KINDS) {
      const status = await inspect(circuitsRoot, circuit, kind, entry)
      if (status) artifacts.push(status)
    }
  }
  if (artifacts.length === 0) {
    return absent('the card artifact lock distributes no provable artifact')
  }
  const ready = artifacts.every((status) => status.matchesPin)
  return {
    localProvingAvailable: ready,
    // Propagated verbatim, never softened: every screen that claims the
    // coordinator cannot see your hand has to carry this alongside it.
    ceremony: typeof lock.ceremony === 'string' ? lock.ceremony : 'uncontributed-demo-only',
    lockPath,
    totalDownloadBytes:
      typeof lock.browser?.totalDownloadBytes === 'number' ? lock.browser.totalDownloadBytes : 0,
    artifacts,
    remedy: ready ? null : REMEDY,
    unavailable: null,
  }
}

/** One terminal line, in the repository's decision/effect/next-action voice. */
export function cardDuelReadinessLine(readiness: CardDuelReadiness): string {
  if (readiness.localProvingAvailable) {
    const megabytes = (readiness.totalDownloadBytes / 1_000_000).toFixed(1)
    return `Decision: The hidden-card duel can be proved in the browser (${megabytes} MB of ${readiness.ceremony} artifacts served by this coordinator).`
  }
  const broken = readiness.artifacts
    .filter((status) => !status.matchesPin)
    .map((status) => `${status.path} ${status.problem ?? 'is unusable'}`)
  const cause = readiness.unavailable ?? broken.join('; ')
  return `Decision: The hidden-card duel cannot be proved in the browser on this stand. Blocker: ${cause}. Next action: ${readiness.remedy ?? REMEDY}.`
}
