import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { cardDuelReadiness, cardDuelReadinessLine } from '../src/card-readiness.ts'

/// The card readiness check decides whether the vending stand may claim local
/// browser proving. Every case below builds a real circuits root on disk, so a
/// change to the lock schema or to the digest check fails here rather than
/// leaving an operator to find out from a visitor.

const LOCK_FORMAT = 'zkdeal/card-artifacts-lock/v4'

type Built = { root: string }

/// Write a circuits root holding a lock and, optionally, the files it pins.
async function circuitsRoot(options: {
  wasm?: Buffer | null
  zkey?: Buffer | null
  wasmDigest?: string
  format?: string
}): Promise<Built> {
  const root = await mkdtemp(join(tmpdir(), 'zkdeal-card-'))
  await mkdir(join(root, 'build', 'card', 'deck-init-v4'), { recursive: true })
  const wasm = options.wasm === undefined ? Buffer.from('wasm bytes') : options.wasm
  const zkey = options.zkey === undefined ? Buffer.from('zkey bytes') : options.zkey
  if (wasm) await writeFile(join(root, 'build/card/deck-init-v4/deck-init-v4.wasm'), wasm)
  if (zkey) await writeFile(join(root, 'build/card/deck-init-v4/deck-init-v4.demo.zkey'), zkey)
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  await writeFile(
    join(root, 'card-artifacts.lock.json'),
    JSON.stringify({
      format: options.format ?? LOCK_FORMAT,
      ceremony: 'uncontributed-demo-only',
      browser: { totalDownloadBytes: 25_559_618 },
      circuits: {
        'deck-init-v4': {
          wasmSha256: options.wasmDigest ?? digest(wasm ?? Buffer.alloc(0)),
          demoZkeySha256: digest(zkey ?? Buffer.alloc(0)),
          distribution: {
            wasm: {
              path: 'build/card/deck-init-v4/deck-init-v4.wasm',
              bytes: (wasm ?? Buffer.alloc(0)).length,
            },
            zkey: {
              path: 'build/card/deck-init-v4/deck-init-v4.demo.zkey',
              bytes: (zkey ?? Buffer.alloc(0)).length,
            },
          },
        },
      },
    }),
  )
  return { root }
}

test('a complete, digest-matching circuits root can prove in the browser', async () => {
  const { root } = await circuitsRoot({})
  const readiness = await cardDuelReadiness(root)
  assert.equal(readiness.localProvingAvailable, true)
  assert.equal(readiness.remedy, null)
  assert.equal(readiness.unavailable, null)
  assert.equal(readiness.artifacts.length, 2)
  assert.ok(readiness.artifacts.every((entry) => entry.matchesPin))
  // The ceremony travels verbatim; softening it would let a UI claim more than
  // an uncontributed key can support.
  assert.equal(readiness.ceremony, 'uncontributed-demo-only')
  assert.match(cardDuelReadinessLine(readiness), /can be proved in the browser/)
  assert.match(cardDuelReadinessLine(readiness), /uncontributed-demo-only/)
})

test('an unbuilt zkey is reported as unbuilt, with the command that fixes it', async () => {
  const { root } = await circuitsRoot({ zkey: null })
  const readiness = await cardDuelReadiness(root)
  assert.equal(readiness.localProvingAvailable, false)
  const zkey = readiness.artifacts.find((entry) => entry.kind === 'zkey')
  assert.ok(zkey)
  assert.equal(zkey.actualBytes, null)
  assert.equal(zkey.problem, 'not built in this image')
  // The wasm beside it is fine, so the report must not condemn the whole root.
  assert.equal(readiness.artifacts.find((entry) => entry.kind === 'wasm')?.matchesPin, true)
  const line = cardDuelReadinessLine(readiness)
  assert.match(line, /cannot be proved in the browser/)
  assert.match(line, /build:card/)
})

test('a truncated artifact is reported by LENGTH, not as a wrong file', async () => {
  const { root } = await circuitsRoot({})
  // Rewrite the wasm shorter than the lock says, leaving the digest stale.
  await writeFile(join(root, 'build/card/deck-init-v4/deck-init-v4.wasm'), Buffer.from('short'))
  const readiness = await cardDuelReadiness(root)
  assert.equal(readiness.localProvingAvailable, false)
  const wasm = readiness.artifacts.find((entry) => entry.kind === 'wasm')
  assert.ok(wasm)
  assert.equal(wasm.actualBytes, 5)
  assert.match(wasm.problem ?? '', /^is 5 bytes, pinned at /)
})

test('a same-length substitution is caught by the digest', async () => {
  const { root } = await circuitsRoot({})
  await writeFile(
    join(root, 'build/card/deck-init-v4/deck-init-v4.wasm'),
    Buffer.from('WASM BYTES'), // same length, different bytes
  )
  const readiness = await cardDuelReadiness(root)
  assert.equal(readiness.localProvingAvailable, false)
  const wasm = readiness.artifacts.find((entry) => entry.kind === 'wasm')
  assert.equal(wasm?.problem, 'does not match its pinned sha256')
})

test('an unusable digest in the lock is refused rather than trusted', async () => {
  const { root } = await circuitsRoot({ wasmDigest: 'not-a-digest' })
  const readiness = await cardDuelReadiness(root)
  assert.equal(readiness.localProvingAvailable, false)
  assert.equal(
    readiness.artifacts.find((entry) => entry.kind === 'wasm')?.problem,
    'has no usable digest in the lock',
  )
})

test('a missing or foreign lock reports, and never throws', async () => {
  const nowhere = await cardDuelReadiness(join(tmpdir(), 'zkdeal-card-absent-root'))
  assert.equal(nowhere.localProvingAvailable, false)
  assert.match(nowhere.unavailable ?? '', /card artifact lock is unreadable/)
  assert.match(cardDuelReadinessLine(nowhere), /Next action: /)

  const { root } = await circuitsRoot({ format: 'zkdeal/card-artifacts-lock/v9' })
  const foreign = await cardDuelReadiness(root)
  assert.equal(foreign.localProvingAvailable, false)
  assert.match(foreign.unavailable ?? '', /declares format zkdeal\/card-artifacts-lock\/v9/)
})

test('the repository lock is the one the coordinator image is expected to carry', async () => {
  // Pinned against the real file, so a schema change in circuits/ that this
  // module cannot read fails here instead of in an enclave.
  const repository = resolve(import.meta.dirname, '..', '..', '..', '..', 'web3-protocol', 'circuits')
  const readiness = await cardDuelReadiness(repository)
  assert.equal(readiness.unavailable, null, 'the tracked lock must be readable')
  assert.equal(readiness.ceremony, 'uncontributed-demo-only')
  assert.equal(readiness.totalDownloadBytes, 25_559_618)
  assert.deepEqual(
    readiness.artifacts.map((entry) => `${entry.circuit}:${entry.kind}`).sort(),
    ['deck-init-v4:wasm', 'deck-init-v4:zkey', 'hand-action-v4:wasm', 'hand-action-v4:zkey'],
  )
  // Whether they are BUILT here is a property of the machine, not of the repo,
  // so this test asserts only that the answer is decided rather than guessed.
  for (const entry of readiness.artifacts) {
    assert.equal(typeof entry.matchesPin, 'boolean')
    assert.equal(entry.matchesPin, entry.problem === null)
  }
})
