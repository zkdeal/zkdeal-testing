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
