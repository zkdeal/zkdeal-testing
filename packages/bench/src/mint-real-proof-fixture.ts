import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, toBytes } from 'viem'
import { requestJson, requestProof, type PreparedRoom } from './prover-client.ts'

/**
 * Mint the Solidity suite's one real CUDA proof fixture from the same
 * prepare/prove boundary used by the Kurtosis acceptance runner.
 *
 * This intentionally talks to exactly one already-running production prover.
 * It neither starts a fallback prover nor accepts a development receipt.
 */
async function run(): Promise<void> {
  const defaultOutput = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../web3-protocol/contracts/test/fixtures/room-v5-real-proof.json',
  )
  const output = resolve(process.argv[2] ?? defaultOutput)
  const prepareRequest = {
    deploymentDomain: keccak256(toBytes('zkdeal/kurtosis/demo-v6')),
    roomId: 1,
    l1ChainId: 31337,
    l1InclusionDeadline: 1_000_000,
    authorizationMode: 'unanimous-approvers',
    activeSigners: 1,
    participantCapacity: 128,
    registeredParticipants: 1,
    touchedParticipants: 1,
    touchedContracts: 1,
    residentAccounts: 2,
    residentMirrorVariables: 1,
    importedVariables: 0,
    workload: 'storage',
    stateCommitment: 'mpt',
  } as const

  // '/v5/...' mirrors the prover binary's HTTP surface (changes only in the gated image ceremony).
  const prepared = await requestJson<PreparedRoom>('/v5/rooms/prepare', prepareRequest)
  const coldProof = await requestProof('/v5/cold-templates/prove', prepared.coldRequest)
  const roomProof = await requestProof('/v5/rooms/prove', prepared.roomRequest)
  if (!roomProof.journal || !roomProof.journalHash) {
    throw new Error('the production prover omitted the journal or its digest')
  }
  if (coldProof.programId.toLowerCase() !== roomProof.programId.toLowerCase()) {
    throw new Error('cold and room proofs were produced by different guest programs')
  }

  const sealHex = (base64: string): `0x${string}` => {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0) throw new Error('the production prover returned an empty seal')
    return `0x${bytes.toString('hex')}`
  }
  const genesisDataHash = prepared.contractConfig?.genesisDataHash
  const canonicalColdTemplateData = prepared.contractConfig?.canonicalColdTemplateData
  if (!genesisDataHash || !canonicalColdTemplateData) {
    throw new Error('the production prover omitted the genesis binding the v6 registry statement requires')
  }
  if (coldProof.genesisDataHash && coldProof.genesisDataHash.toLowerCase() !== genesisDataHash.toLowerCase()) {
    throw new Error('the cold proof committed a different genesis data hash than the prepared template')
  }
  const fixture = {
    proofSystem: 'risc0-groth16',
    programId: roomProof.programId,
    journalHash: roomProof.journalHash,
    seal: sealHex(roomProof.ethereumSealB64),
    coldSeal: sealHex(coldProof.ethereumSealB64),
    genesisDataHash,
    canonicalColdTemplateData,
    journal: roomProof.journal,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  const provenanceOutput = process.env.PROVENANCE_OUT?.trim()
  if (provenanceOutput) {
    const provenance = {
      schema: 'zkdeal/b200-real-proof-fixture-provenance/v1',
      generatedAtUtc: new Date().toISOString(),
      programId: roomProof.programId,
      coldTemplate: {
        elapsedMs: coldProof.elapsedMs,
        gpuName: coldProof.gpuName,
        gpuUuid: coldProof.gpuUuid,
        profile: coldProof.profile,
        imageId: coldProof.imageId,
        containerDigest: coldProof.containerDigest,
      },
      room: {
        elapsedMs: roomProof.elapsedMs,
        gpuName: roomProof.gpuName,
        gpuUuid: roomProof.gpuUuid,
        profile: roomProof.profile,
        imageId: roomProof.imageId,
        containerDigest: roomProof.containerDigest,
      },
    }
    await mkdir(dirname(resolve(provenanceOutput)), { recursive: true })
    await writeFile(resolve(provenanceOutput), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`Decision: fresh zkdeal CUDA proof fixture minted at ${output}\n`)
}

await run()
