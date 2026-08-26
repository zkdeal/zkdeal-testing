$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\kurtosis.ps1')
$Enclave = if ($env:ZKDEAL_ENCLAVE) { $env:ZKDEAL_ENCLAVE } else { 'zkdeal-demo' }
$Kurtosis = Resolve-Kurtosis -Root $Root

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $Kurtosis service stop $Enclave zkdeal-demo risc0-cuda-prover *> $null
$stopped = $LASTEXITCODE -eq 0
$ErrorActionPreference = $previous
if (-not $stopped) {
    Write-Host 'Decision: Demo was already stopped or unavailable'
    Write-Host 'Evidence: No running service was changed.'
    Write-Host 'Next action: Run pnpm demo:start when the presentation is needed.'
    exit 0
}
Write-Host 'Decision: Demo console and GPU prover are stopped'
Write-Host 'Evidence: Rooms, jobs and proof evidence remain in the enclave.'
Write-Host 'Evidence: Local Ethereum remains available so its chain history is not discarded.'
Write-Host 'Next action: Run pnpm demo:start to resume without resetting.'
Write-Host 'Resource budget: The GPU proving slot has been released.'
