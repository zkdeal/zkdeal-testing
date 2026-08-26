import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, test } from 'vitest'

// run-platform.mjs dispatches each .sh/.ps1 pair by host OS, so any divergence
// between a pair is an OS-dependent behaviour change rather than a duplication
// nit. These are the divergences that silently corrupted evidence.
const scriptsDir = resolve(fileURLToPath(import.meta.url), '..')
const read = (name: string) => readFileSync(resolve(scriptsDir, name), 'utf8')

// One builder now produces the image set. There used to be two writers of
// kurtosis/params/test.generated.yaml - a v4 builder substituting a key schema
// the package rejects, and a demo builder - and that shared output path
// with incompatible writers was the seam most of this file's regressions ran
// through.
const buildShell = read('build-docker-images.sh')
const buildPowerShell = read('build-docker-images.ps1')

describe('build-docker-images pair', () => {
  // The shell variant built CUDA_ARCH=89 (Ada) and the PowerShell variant
  // CUDA_ARCH=86 (Ampere) for the same host, so the compiled prover kernels
  // depended on which OS started the stack.
  test.each([
    ['shell', buildShell],
    ['PowerShell', buildPowerShell],
  ])('%s variant derives the CUDA arch from the device', (_label, source) => {
    expect(source).not.toMatch(/CUDA_ARCH=\d/)
    expect(source).toContain('--query-gpu=compute_cap')
    expect(source).toContain('ZKDEAL_CUDA_ARCH')
  })

  // The writer of the args file Kurtosis actually runs had no leftover-token
  // guard, so a renamed template key would start the stack with an unresolvable
  // image or an unmeasured GPU identity recorded into evidence.
  test.each([
    ['shell', buildShell],
    ['PowerShell', buildPowerShell],
  ])('%s variant refuses to publish an args file with leftover placeholders', (_label, source) => {
    expect(source).toContain('NOT_BUILT|NOT_RUN|NOT_MEASURED|_NOT_SET')
    expect(source).toContain('still contains an unsubstituted template placeholder')
  })

  // The builder targeted a params key schema the current Kurtosis package
  // rejects, and only discovered it after the full CUDA, Foundry and docker
  // work - with the live args file already overwritten.
  test.each([
    ['shell', buildShell],
    ['PowerShell', buildPowerShell],
  ])('%s variant verifies the params template before building', (_label, source) => {
    const guardAt = source.indexOf('does not declare the')
    const buildAt = source.indexOf('risc0-cuda.Dockerfile')
    expect(guardAt).toBeGreaterThan(-1)
    expect(buildAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(buildAt)
  })

  // kurtosis/main.star declares exactly these three locally built images. A
  // variant that substitutes a different subset writes an args file the package
  // fails on, or worse, silently leaves a stale image reference in place.
  it.each([
    ['shell', buildShell],
    ['PowerShell', buildPowerShell],
  ])('%s variant substitutes every locally built image key', (_label, source) => {
    for (const key of ['prover', 'runner', 'server']) {
      expect(source).toContain(`  ${key}: NOT_BUILT`)
    }
  })

  // run-kurtosis-bench.ps1 passed -Bench to a parameter the builder never read,
  // which reads as a deliberate platform behaviour difference. PowerShell only
  // treats a param block as the script's CLI when it is the first statement, so
  // that is the position checked; the internal `function … { param(…) }` blocks
  // are not a command-line surface.
  it('declares no command-line parameter its shell twin cannot express', () => {
    const firstStatement = buildPowerShell
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'))
    expect(firstStatement).not.toMatch(/^param\(/)
  })
})

describe('pinned Foundry image', () => {
  // The authoritative pin moved with the contracts into the web3-protocol
  // folder; the builders read it across the sibling boundary.
  const pin = readFileSync(
    resolve(scriptsDir, '..', '..', 'web3-protocol', 'contracts', 'foundry-image.txt'),
    'utf8',
  )
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))

  it('is one digest-pinned reference', () => {
    expect(pin).toMatch(/^[^@\s]+@sha256:[0-9a-f]{64}$/)
  })

  // The compose files interpolate the same reference from a committed .env;
  // a drifted mirror would compile deployed bytecode with a different image.
  it.each([
    ['web3-protocol', '../../web3-protocol/.env'],
    ['apps-examples', '../../apps-examples/.env'],
  ])('is mirrored byte-for-byte by the %s compose .env', (_label, envPath) => {
    const mirrored = readFileSync(resolve(scriptsDir, envPath), 'utf8').match(
      /^FOUNDRY_IMAGE=(.+)$/m,
    )?.[1]
    expect(mirrored).toBe(pin)
  })

  // The demo builders used the mutable v1.7.1 tag, so the contracts the stack
  // deploys were compiled by whatever that tag resolved to that day.
  it.each([
    ['shell', buildShell],
    ['PowerShell', buildPowerShell],
  ])('%s builder reads the pin instead of naming an image', (_label, source) => {
    expect(source).toContain('foundry-image.txt')
    expect(source).not.toMatch(/ghcr\.io\/foundry-rs\/foundry:/)
  })
})

describe('kurtosis runner pairs', () => {
  const testShell = read('run-kurtosis-test.sh')
  const testPowerShell = read('run-kurtosis-test.ps1')

  // `pnpm kurtosis:test -- --replace` reached PowerShell as an unbound
  // positional and died with a parameter-binding error, on the runner that
  // gates GPU release evidence.
  it('PowerShell integration runner accepts the documented --replace flag', () => {
    expect(testPowerShell).toContain('ValueFromRemainingArguments')
    expect(testPowerShell).toContain("$RemainingArguments -contains '--replace'")
  })

  // A fixed, never-cleared download directory let a failed download leave the
  // previous run's artifact behind and be reported as validated evidence.
  it.each([
    ['shell', testShell, /gpu-integration\/\$\{?ENCLAVE\}?/],
    ['PowerShell', testPowerShell, /gpu-integration\\\$Enclave/],
  ])('%s integration runner downloads into a per-run directory', (_label, source, pattern) => {
    expect(source).toMatch(pattern)
  })

  // The runner ends with the packages/bench evidence validator. Discovering
  // that it no longer exists after a GPU budget is spent is the failure this
  // precondition exists to prevent; the v4 refactor removed `validate:v4` out
  // from under the benchmark runner exactly that way.
  test.each([
    ['shell', testShell],
    ['PowerShell', testPowerShell],
  ])('%s integration runner checks the validator before reserving the GPU', (_label, source) => {
    const guardAt = source.indexOf('no longer defines the validate')
    const enclaveAt = source.search(/Initialize-Enclave|prepare_enclave/)
    expect(guardAt).toBeGreaterThan(-1)
    expect(enclaveAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(enclaveAt)
  })

  // --no-build skips the only producer of the generated args file, which is
  // gitignored and therefore absent in every clean clone.
  it.each([
    ['shell', read('run-kurtosis-demo.sh')],
    ['PowerShell', read('run-kurtosis-demo.ps1')],
  ])('%s demo runner checks the generated args file exists', (_label, source) => {
    const guardAt = source.indexOf('--no-build skipped the step that generates it')
    const runAt = source.indexOf('--args-file')
    expect(guardAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(runAt)
  })

  // Both runners must reach the one builder that writes the args file.
  it.each([
    ['shell demo', read('run-kurtosis-demo.sh')],
    ['PowerShell demo', read('run-kurtosis-demo.ps1')],
    ['shell integration', testShell],
    ['PowerShell integration', testPowerShell],
  ])('%s runner builds through build-docker-images', (_label, source) => {
    expect(source).toContain('build-docker-images')
    expect(source).not.toContain('build-demo-images')
  })
})

describe('demo-status pair', () => {
  const statusShell = read('demo-status.sh')
  const statusPowerShell = read('demo-status.ps1')

  // The shell variant called any 2xx "ready", asserting readiness for a room
  // whose startup Groth16 canary may never have reached L1.
  it.each([
    ['shell', statusShell],
    ['PowerShell', statusPowerShell],
  ])('%s variant decides on the startup canary, not on a 2xx', (_label, source) => {
    expect(source).toContain('startup canary is incomplete')
    expect(source).toMatch(/canary/)
  })

  // canary.status never existed on the demo system report; the block itself is
  // the L1-accepted signal, so the old comparison could never be true.
  it.each([
    ['shell', statusShell, 'system?.canary != null'],
    ['PowerShell', statusPowerShell, '($null -ne $system.canary)'],
  ])('%s variant reads the canary block, not a canary.status field', (_label, source, predicate) => {
    expect(source).toContain(predicate)
  })
})
