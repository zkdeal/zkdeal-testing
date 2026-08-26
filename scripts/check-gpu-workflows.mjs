// Guard for the GPU release path: the one required real-proof integration job,
// the Kurtosis package it drives, and the runner pair that must preserve an
// enclave rather than destroy it. The Kurtosis package must stay CUDA-only and
// must not be runnable from a checked-in template.
//
// Every input is loaded through read(), so a file a refactor deletes or renames
// is reported as a named gate failure instead of crashing the gate with an
// unhandled ENOENT rejection.
//
// Two v4-era shapes are deliberately gone rather than relaxed. The bench/test
// mode split disappeared with the v4 Kurtosis package, so the benchmark policy
// is asserted against the checked-in runbook. The separate manual/scheduled
// publication-evidence workflow disappeared with the v4 bench harness, so what
// is guarded now is that its multi-day path cannot reappear on an automatic
// trigger: no workflow may invoke the retired benchmark runner at all.
//
// Where a string carries a protocol version token that is incidental to the
// invariant - enclave names, evidence directories - the assertion is a pattern
// rather than a literal. Hard-coding `v4` there is what made this gate rot
// against its own repository the last time the protocol moved.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// scripts/ → kurtosis-testing; the workflows live at the umbrella root's
// .github, which is the one directory the folder split could not relocate
// (GitHub Actions reads workflows only from the repository root).
const root = resolve(import.meta.dirname, '..')
const umbrella = resolve(root, '..')
const errors = []

const read = async (label, path, base = root) => {
  try {
    return await readFile(resolve(base, path), 'utf8')
  } catch {
    errors.push(`${label} is unavailable: ${path} does not exist`)
    return null
  }
}

const [
  integration,
  hosted,
  main,
  testParams,
  runbook,
  testPowerShell,
  testShell,
  shellLib,
  powerShellLib,
  imageBuildShell,
  imageBuildPowerShell,
  gitignore,
] = await Promise.all([
  read('required GPU integration workflow', '.github/workflows/gpu-ci.yml', umbrella),
  read('hosted CI workflow', '.github/workflows/ci.yml', umbrella),
  read('Kurtosis package', 'package/main.star'),
  read('test params', 'package/params/test.yaml'),
  read('GPU evidence runbook', 'docs/GPU-EVIDENCE-RUNBOOK.md'),
  read('PowerShell integration runner', 'scripts/run-kurtosis-test.ps1'),
  read('shell integration runner', 'scripts/run-kurtosis-test.sh'),
  read('shell runner library', 'scripts/lib/kurtosis.sh'),
  read('PowerShell runner library', 'scripts/lib/kurtosis.ps1'),
  read('shell image builder', 'scripts/build-docker-images.sh'),
  read('PowerShell image builder', 'scripts/build-docker-images.ps1'),
  read('evidence ignore policy', '.gitignore'),
])

const requireText = (label, text, needle) => {
  if (text === null) return
  if (!text.includes(needle)) errors.push(`${label} must contain ${JSON.stringify(needle)}`)
}
const forbidText = (label, text, needle) => {
  if (text === null) return
  if (text.includes(needle)) errors.push(`${label} must not contain ${JSON.stringify(needle)}`)
}
const requireMatch = (label, text, pattern, description) => {
  if (text === null) return
  if (!pattern.test(text)) errors.push(`${label} must ${description}`)
}
const forbidMatch = (label, text, pattern, description) => {
  if (text === null) return
  if (pattern.test(text)) errors.push(`${label} must not ${description}`)
}

const historyCommand = /\bgit\s+(?:status|diff|rev-parse|submodule|describe|log|show|ls-files|checkout|reset|clean|clone|fetch|pull|add|commit)\b/i
for (const [label, source] of [
  ['required GPU integration workflow', integration],
  ['hosted CI workflow', hosted],
  ['PowerShell integration runner', testPowerShell],
  ['shell integration runner', testShell],
  ['shell runner library', shellLib],
  ['PowerShell runner library', powerShellLib],
  ['shell image builder', imageBuildShell],
  ['PowerShell image builder', imageBuildPowerShell],
]) {
  forbidMatch(label, source, historyCommand, 'invoke repository-history commands')
}
for (const [label, source] of [
  ['shell image builder', imageBuildShell],
  ['PowerShell image builder', imageBuildPowerShell],
]) {
  requireText(label, source, 'SOURCE_MANIFEST_SHA256')
  requireText(label, source, 'check-lock-freshness.mjs')
  forbidText(label, source, 'SOURCE_COMMIT')
}

requireText('required GPU integration workflow', integration, 'pnpm kurtosis:test')
// A fixed enclave name is shared with every other job on the runner, so a
// re-run would destroy or inherit the previous run's enclave.
requireMatch(
  'required GPU integration workflow',
  integration,
  /ZKDEAL_ENCLAVE = "zkdeal-[a-z0-9-]*\$env:GITHUB_RUN_ID-\$env:GITHUB_RUN_ATTEMPT"/,
  'derive its enclave name from GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT',
)
requireText('required GPU integration workflow', integration, 'timeout-minutes: 720')
requireText('required GPU integration workflow', integration, 'RISC0_DEV_MODE: "0"')
forbidText('required GPU integration workflow', integration, 'RISC0_DEV_MODE: "1"')
// The stable required check name branch protection points at. `always()` is what
// stops a skipped fork run from reading as proof coverage.
requireMatch(
  'required GPU integration workflow',
  integration,
  /name: [^\n]*\(required\)/,
  'declare an aggregate job whose name ends in "(required)"',
)
requireMatch(
  'required GPU integration workflow',
  integration,
  /test-results\/hosting-gpu-integration\/\*\*/,
  'upload the integration evidence directory it wrote',
)
forbidText('required GPU integration workflow', integration, '-Replace')

// The multi-day benchmark matrix was retired with the v4 bench harness. It must
// not come back on an automatic trigger; no workflow may invoke it at all.
for (const [label, workflow] of [
  ['required GPU integration workflow', integration],
  ['hosted CI workflow', hosted],
]) {
  forbidText(label, workflow, 'kurtosis:bench')
  forbidText(label, workflow, 'bench-results.json')
}

// Preservation can legitimately live in the runner or in the shared helper it
// sources, so the required behaviour is asserted over both; destruction may not
// migrate into the helper, so the forbid list stays on the runner itself.
for (const [label, runner, lib, exitMarker] of [
  ['PowerShell integration runner', testPowerShell, powerShellLib, 'exit $OriginalExit'],
  ['shell integration runner', testShell, shellLib, 'exit "$status"'],
]) {
  const withLib = runner === null || lib === null ? runner : `${runner}\n${lib}`
  requireText(label, withLib, 'enclave inspect')
  requireText(label, withLib, 'service logs')
  requireText(label, withLib, '--all-services --all')
  requireText(label, withLib, 'enclave dump')
  requireText(label, runner, exitMarker)
  forbidText(label, runner, 'enclave rm')
  forbidText(label, runner, 'kurtosis clean')
}

// The runners' own `enclave rm` prohibition became vacuous when enclave
// lifecycle moved into the shared helpers, which the loop above does not read
// for forbidden text. The helper is allowed exactly one removal and only behind
// the opt-in replace flag; a second, unguarded one must fail this gate.
for (const [label, lib, optIn, invocation] of [
  ['shell runner library', shellLib, '--replace to destroy and recreate it', /^\s*"\$kurtosis" enclave rm /gmu],
  ['PowerShell runner library', powerShellLib, '-Replace to destroy and recreate it', /^\s*& \$Kurtosis enclave rm /gmu],
]) {
  if (lib === null) continue
  const removals = [...lib.matchAll(invocation)].length
  if (removals !== 1) {
    errors.push(`${label} must invoke "enclave rm" exactly once, behind the opt-in flag; found ${removals}`)
  }
  requireText(label, lib, optIn)
  forbidText(label, lib, 'kurtosis clean')
}

// The checked-in Kurtosis params template must stay a non-executable v6
// template that carries no benchmark policy. Only a generated file may be
// runnable, and the publication matrix belongs to the runbook.
requireText('test params', testParams, 'status: NOT_RUN')
requireText('test params', testParams, 'protocol_version: 6')
requireText('test params', testParams, '  prover: NOT_BUILT')
forbidText('test params', testParams, 'primary_attempts:')

// The package has no bench/test mode split. What must not regress is that it
// refuses to run from a checked-in template and proves only on CUDA with no
// development-mode fallback.
requireText('Kurtosis package', main, 'status must be READY; checked-in templates are intentionally not executable')
requireText('Kurtosis package', main, 'protocol_version must be 6')
requireText('Kurtosis package', main, '"RISC0_DEV_MODE": "0"')
requireText('Kurtosis package', main, '"RISC0_REQUIRE_CUDA": "1"')
forbidText('Kurtosis package', main, '"RISC0_DEV_MODE": "1"')

// The benchmark policy and the clean/dirty publication rule are checked-in
// prose now that the v4 bench gate and its params template are gone. The
// runbook is the only remaining source, so it is the one guarded.
requireText('GPU evidence runbook', runbook, 'six-test')
requireText('GPU evidence runbook', runbook, 'exactly 100 primary attempts and at least 95/100 successes')
requireText('GPU evidence runbook', runbook, 'exactly 1,000 independent canonical attempts')
requireText('GPU evidence runbook', runbook, '1,800 matrix attempts')
requireText('GPU evidence runbook', runbook, 'The Kurtosis benchmark runner has 72 hours.')
requireText('GPU evidence runbook', runbook, '96 hours')
requireText('GPU evidence runbook', runbook, 'dirty source trees are diagnostic-only')
requireText('GPU evidence runbook', runbook, 'non-publishable')
requireText('evidence ignore policy', gitignore, 'gpu-*-evidence/')

if (errors.length > 0) {
  console.error(['GPU workflow guard failed:', ...errors.map((error) => `  - ${error}`)].join('\n'))
  process.exit(1)
}
console.log('GPU workflow guard passed: the required real-proof gate, its Kurtosis package and its runner pair are intact')
