# Host-side launcher for the persistent RTX 4090 demo machine: it runs an
# already-staged package copy from a scheduled task, and is deliberately not
# part of pnpm demo:start, any gate or any workflow. The two absolute paths are
# that host's layout; override them per host rather than editing this file.
$ErrorActionPreference = 'Stop'

$DemoRoot = if ($env:ZKDEAL_DEMO_ROOT) { $env:ZKDEAL_DEMO_ROOT } else { 'C:\ProgramData\zkdeal-recording' }
$Kurtosis = if ($env:ZKDEAL_KURTOSIS_BIN) {
    $env:ZKDEAL_KURTOSIS_BIN
} else {
    Join-Path $DemoRoot 'kurtosis.exe'
}
$Enclave = $env:ZKDEAL_ENCLAVE
$Package = Join-Path $DemoRoot 'kurtosis'
$Arguments = Join-Path $Package 'params\test.generated.yaml'
$PrivateLog = Join-Path $DemoRoot 'kurtosis-private.log'
$Status = Join-Path $DemoRoot 'launcher-status.txt'

if (-not (Test-Path -LiteralPath $Kurtosis)) {
    Set-Content -LiteralPath $Status -Value 'Decision: launcher failed; Kurtosis is unavailable.'
    exit 1
}
if (-not $Enclave -or $Enclave -notmatch '^zkdeal-recording-[a-zA-Z0-9-]+$') {
    Set-Content -LiteralPath $Status -Value 'Decision: launcher failed; ZKDEAL_ENCLAVE must name the staged zkdeal-recording-* enclave.'
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $Package 'main.star'))) {
    Set-Content -LiteralPath $Status -Value 'Decision: launcher failed; the demo package is unavailable.'
    exit 1
}
if (-not (Test-Path -LiteralPath $Arguments)) {
    Set-Content -LiteralPath $Status -Value 'Decision: launcher failed; generated parameters are unavailable.'
    exit 1
}

Set-Content -LiteralPath $Status -Value 'Decision: launcher is preparing the persistent demo.'
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $Kurtosis analytics disable *> $null
& $Kurtosis run $Package `
    --args-file $Arguments `
    --enclave $Enclave `
    --verbosity BRIEF `
    --image-download missing *> $PrivateLog
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference

if ($exitCode -eq 0) {
    Set-Content -LiteralPath $Status -Value 'Decision: persistent demo startup completed.'
    exit 0
}

Set-Content -LiteralPath $Status -Value 'Decision: persistent demo startup failed; inspect the private log.'
exit $exitCode
