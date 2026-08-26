import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, test } from 'vitest'

const scriptsDir = resolve(fileURLToPath(import.meta.url), '..')
const repoRoot = resolve(scriptsDir, '..')
const gate = resolve(scriptsDir, 'check-gpu-workflows.mjs')
const temporaryRoots: string[] = []

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

describe('check:gpu-workflows', () => {
  // Before the repair this gate read kurtosis/params/bench.yaml and
  // packages/bench/src/v4-gate.ts unconditionally; both were deleted in the v5
  // refactor, so the required CI step died with an unhandled ENOENT rejection.
  test('passes on the checked-in tree', () => {
    const result = spawnSync(process.execPath, [gate], { cwd: repoRoot, encoding: 'utf8' })
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/ENOENT|UnhandledPromiseRejection/)
    expect(result.stdout).toContain('GPU workflow guard passed')
    expect(result.status).toBe(0)
  })

  test('reports every missing input as a named gate failure instead of crashing', () => {
    // The gate anchors on its own location, so a copy in an empty tree sees
    // none of its inputs. That is the exact situation a deleting refactor
    // creates, and it must produce named failures rather than a stack trace.
    const emptyRoot = mkdtempSync(resolve(tmpdir(), 'zkdeal-gpu-gate-'))
    temporaryRoots.push(emptyRoot)
    mkdirSync(resolve(emptyRoot, 'scripts'))
    copyFileSync(gate, resolve(emptyRoot, 'scripts', 'check-gpu-workflows.mjs'))

    const result = spawnSync(process.execPath, [resolve(emptyRoot, 'scripts', 'check-gpu-workflows.mjs')], {
      cwd: emptyRoot,
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).not.toMatch(/ENOENT|UnhandledPromiseRejection|at async/)
    expect(result.stderr).toContain('required GPU integration workflow is unavailable')
    expect(result.stderr).toContain('Kurtosis package is unavailable')
    expect(result.stderr).toContain('GPU evidence runbook is unavailable')
  })
})
