$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\kurtosis.ps1')
$Enclave = if ($env:ZKDEAL_ENCLAVE) { $env:ZKDEAL_ENCLAVE } else { 'zkdeal-demo' }
$Kurtosis = Resolve-Kurtosis -Root $Root

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $Kurtosis enclave inspect $Enclave *> $null
$exists = $LASTEXITCODE -eq 0
$ErrorActionPreference = $previous
if (-not $exists) {
    Write-Host 'Decision: Long-running demo is stopped'
    Write-Host 'Evidence: No persistent demo enclave is available.'
    Write-Host 'Next action: Run pnpm demo:start.'
    Write-Host 'Resource budget: No GPU slot is reserved.'
    exit 1
}

$demo = (& $Kurtosis port print $Enclave zkdeal-demo http --format ip,number 2>$null).Trim()
if ($demo -notmatch '^([^:]+):([0-9]+)$') {
    Write-Host 'Decision: Demo services exist but the console is unavailable'
    Write-Host 'Blocker: The web service has no published port.'
    Write-Host 'Next action: Restart with pnpm demo:start -- --reset.'
    Write-Host 'Resource budget: The existing enclave has been preserved.'
    exit 1
}

try {
    $system = Invoke-RestMethod -Uri "http://$demo/demo/v1/system" -TimeoutSec 8
    # The startup canary reaching L1 is reported as a non-null `canary` block
    # (server/src/demo-control.ts DemoSystemStatus); there is no
    # `canary.status` field, so the old comparison could never be true and this
    # command reported an incomplete canary for a fully ready demo.
    $ready = ($system.decision -eq 'READY') -and ($null -ne $system.canary)
    $decision = if ($ready) { 'Long-running demo is ready' } else { 'Demo is running; startup canary is incomplete' }
    Write-Host "Decision: $decision"
    # Same fallbacks as demo-status.sh, so an absent field reads identically on
    # both platforms instead of rendering as an empty gap in the Evidence line.
    $serviceCount = if ($system.services) { @($system.services).Count } else { 0 }
    $gpuSeconds = if ($null -ne $system.gpu.recommendedProofSeconds) {
        $system.gpu.recommendedProofSeconds
    } else {
        'unknown'
    }
    Write-Host "Evidence: $serviceCount services reported; GPU allowance is $gpuSeconds seconds."
    Write-Host "Demo UI: http://$demo/demo/"
    Write-Host "API: http://$demo/demo/v1/system"
    # The observers are additive and may be absent on a legacy enclave, so a
    # missing service silently skips its line instead of failing the report.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $grafana = (& $Kurtosis port print $Enclave grafana http --format ip,number 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { $grafana = '' }
    $prometheus = (& $Kurtosis port print $Enclave prometheus http --format ip,number 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { $prometheus = '' }
    $ErrorActionPreference = $previous
    if ($grafana -match '^[^:]+:([0-9]+)$') { Write-Host "Grafana:  http://127.0.0.1:$($Matches[1])/" }
    if ($prometheus -match '^[^:]+:([0-9]+)$') { Write-Host "Prometheus: http://127.0.0.1:$($Matches[1])/" }
    Write-Host 'Next action: Continue the live presentation or create another room.'
    Write-Host 'Resource budget: One local CUDA proving slot, serialized through the persistent queue.'
} catch {
    Write-Host 'Decision: Demo console is not healthy'
    Write-Host 'Blocker: The control plane did not return a readable system report.'
    Write-Host 'Next action: Inspect the enclave service logs and restart only the failed service.'
    Write-Host 'Resource budget: The enclave and its evidence remain preserved.'
    exit 1
}
