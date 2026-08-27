import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const scriptsDir = resolve(fileURLToPath(import.meta.url), '..')
const repoRoot = resolve(scriptsDir, '..')

describe('user-facing Kurtosis invocations', () => {
  test('never passes the dot-prefixed package directory to Kurtosis 1.20.0', () => {
    // Kurtosis 1.20.0 cleans child paths while archiving but trims them against
    // the unclean `./package` argument. That nests kurtosis.yml one directory
    // too deep in the uploaded archive. An explicit manifest, `package`, or an
    // absolute package path does not trigger the bug.
    const brokenDirectoryArgument = new RegExp(
      String.raw`\bkurtosis(?:\.exe)?\s+run\s+(['"]?)\./package\1(?=\s|$)`,
      'i',
    )
    const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean)

    const offenders: string[] = []
    for (const relativePath of trackedFiles) {
      const content = readFileSync(resolve(repoRoot, relativePath))
      if (content.includes(0)) continue
      if (brokenDirectoryArgument.test(content.toString('utf8'))) offenders.push(relativePath)
      brokenDirectoryArgument.lastIndex = 0
    }

    expect(offenders).toEqual([])
  })

  test('the public template uses the explicit package manifest', () => {
    const template = readFileSync(resolve(repoRoot, 'package/params/public.yaml'), 'utf8')
    expect(template).toContain('kurtosis run ./package/kurtosis.yml --args-file')
  })

  test('the public stack rejects PTX fallback compilation', () => {
    const packageSource = readFileSync(resolve(repoRoot, 'package/main.star'), 'utf8')
    expect(packageSource).toContain('"CUDA_DISABLE_PTX_JIT": "1"')
  })

  test('the public listener never receives the process-local admission key', () => {
    const packageSource = readFileSync(resolve(repoRoot, 'package/main.star'), 'utf8')
    const demoStart = packageSource.slice(packageSource.indexOf('def _start_demo('))

    expect(demoStart).toContain('"CHAIN_ID": "31337"')
    expect(demoStart).not.toContain('"ADMISSION_KEY"')
    expect(demoStart).not.toContain('"ADMISSION_DEV_PRIVATE_KEY"')
    expect(demoStart).not.toContain('"ADMISSION_TOKEN"')
  })

  test('the prover agent confines its dev key behind a chain-31337 loopback relay', () => {
    const packageSource = readFileSync(resolve(repoRoot, 'package/main.star'), 'utf8')
    const agentStart = packageSource.slice(
      packageSource.indexOf('def _start_agent('),
      packageSource.indexOf('def _run_example_case('),
    )
    const relaySource = readFileSync(
      resolve(repoRoot, 'packages/bench/src/devnet-prover-agent.ts'),
      'utf8',
    )

    expect(agentStart).not.toContain('"NODE_SERVICE_KEY"')
    expect(agentStart).toContain('"NODE_LIVENESS_DEV_MODE": "true"')
    expect(agentStart).toContain('"NODE_LIVENESS_DEV_PRIVATE_KEY": ROLE_SERVICE_KEY')
    expect(agentStart).toContain('"DEVNET_L1_RPC_UPSTREAM": l1_rpc')
    expect(relaySource).toContain("const DEV_CHAIN_ID = 31_337n")
    expect(relaySource).toContain("server.listen(LOOPBACK_PORT, LOOPBACK_HOST")
    expect(relaySource).toContain("L1_RPC_URL: `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`")
  })

  test('the example runner uses the coordinator-published checkpoint allowance', () => {
    const runnerSource = readFileSync(
      resolve(repoRoot, 'packages/bench/src/example-runner.ts'),
      'utf8',
    )

    expect(runnerSource).not.toContain('EXAMPLE_ROOM_DEADLINE_BLOCKS')
    expect(runnerSource).not.toContain('deadlineBlocksFromStart:')
    expect(runnerSource).toContain('The coordinator owns its')
  })

  test('the managed-room card advertises the preset registered by the v6 bootstrap', () => {
    const packageSource = readFileSync(resolve(repoRoot, 'package/main.star'), 'utf8')
    const registeredV6Preset =
      '0x5573b9e025aca61180407c84fb878ea7986ad7a0d1e77ff13f3ad49f888628dd'

    expect(packageSource).toContain(`"MANAGED_ROOM_PRESET_ID": "${registeredV6Preset}"`)
    expect(packageSource).not.toContain(
      '0xcd2e6acc7f063347942b311bf03db5b29af6311964e856a55ac6fb17aa1597f8',
    )
  })

  test('the example runner accepts only the coordinator final checkpoint phase', () => {
    const runnerSource = readFileSync(
      resolve(repoRoot, 'packages/bench/src/example-runner.ts'),
      'utf8',
    )

    expect(runnerSource).toContain("settled.phase !== 'L1_FINALIZED'")
    expect(runnerSource).toContain('without a finalized checkpoint')
    expect(runnerSource).not.toContain('L1_ACCEPTED')
  })

  test('the public template contains only digest-pinned published images', () => {
    const template = readFileSync(resolve(repoRoot, 'package/params/public.yaml'), 'utf8')
    expect(template).not.toMatch(/REPLACE-AT-PUBLISH|NOT_BUILT/)
    const images = Object.fromEntries(
      [...template.matchAll(/^  (prover|runner|server): (\S+)$/gm)].map((match) => [
        match[1],
        match[2],
      ]),
    )
    for (const key of ['prover', 'runner', 'server']) {
      expect(images[key]).toMatch(/@sha256:[0-9a-f]{64}$/)
    }
    expect(images.runner).toBe(images.server)
  })
})
