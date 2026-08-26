param(
    [switch]$Reset,
    [switch]$NoBuild,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$RemainingArguments
)
$ErrorActionPreference = "Stop"
if ($RemainingArguments -contains '--reset') { $Reset = $true }
if ($RemainingArguments -contains '--no-build') { $NoBuild = $true }
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\kurtosis.ps1')
$Enclave = if ($env:ZKDEAL_ENCLAVE) { $env:ZKDEAL_ENCLAVE } else { 'zkdeal-demo' }
$Kurtosis = Resolve-Kurtosis -Root $Root
Assert-KurtosisSources -Root $Root

function Enclave-Exists {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Kurtosis enclave inspect $Enclave *> $null
    $exists = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previous
    return $exists
}

function Read-PublishedPort {
    param([string]$Service, [string]$Port)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $value = (& $Kurtosis port print $Enclave $Service $Port --format ip,number 2>$null | Out-String).Trim()
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($exitCode -ne 0) { return '' }
    return $value
}

function Print-Links {
    $tls = Read-PublishedPort -Service 'tls-gateway' -Port 'https'
    $explorer = Read-PublishedPort -Service 'explorer' -Port 'http'
    if ($tls -notmatch '^([^:]+):([0-9]+)$') { throw 'The TLS gateway has no published HTTPS port.' }
    if ($explorer -notmatch '^([^:]+):([0-9]+)$') { throw 'The public explorer service has no published web port.' }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $payload = (& curl.exe --fail --silent --show-error --insecure --max-time 15 "https://$tls/demo/v1/system" 2>$null | Out-String).Trim()
    $curlExit = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($curlExit -ne 0 -or -not $payload) { throw 'The published HTTPS origin did not return the system report.' }
    try {
        $system = $payload | ConvertFrom-Json
    } catch {
        throw 'The published HTTPS origin returned an unreadable system report.'
    }
    if (
        $system.decision -ne 'READY' -or
        $null -eq $system.canary -or
        $system.apiUrl -notmatch '^https://[^/]+$' -or
        $system.explorerUrl -notmatch '^https?://[^/]+$'
    ) {
        throw 'HTTPS is reachable, but the system report lacks READY, the L1 startup canary, or its HTTPS API identity.'
    }
    Write-Host 'Decision: Long-running demo is ready'
    Write-Host "Demo UI: $($system.apiUrl)/demo/"
    Write-Host "L1 explorer: $($system.explorerUrl)"
    # The observers are additive and may be absent on a legacy enclave, so a
    # missing service silently skips its line instead of failing the report.
    $grafana = Read-PublishedPort -Service 'grafana' -Port 'http'
    if ($grafana -match '^[^:]+:([0-9]+)$') { Write-Host "Grafana:  http://127.0.0.1:$($Matches[1])/" }
    $prometheus = Read-PublishedPort -Service 'prometheus' -Port 'http'
    if ($prometheus -match '^[^:]+:([0-9]+)$') { Write-Host "Prometheus: http://127.0.0.1:$($Matches[1])/" }
    Write-Host "API: $($system.apiUrl)/demo/v1/system"
    Write-Host 'Next action: Open the HTTPS UI and trust only this enclave certificate for capture.'
    Write-Host 'Resource budget: Exactly one CUDA proving service, serialized through the persistent queue.'
}

$exists = Enclave-Exists
if ($exists -and $Reset) {
    Write-Host 'Preparing: replacing the existing demo enclave'
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Kurtosis enclave rm $Enclave --force *> $null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($exitCode -ne 0) { throw 'The existing demo enclave could not be reset.' }
    $exists = $false
}
if ($exists) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Kurtosis service start $Enclave risc0-cuda-prover zkdeal-demo explorer tls-gateway *> $null
    # Separate call: a legacy enclave predating the observers would otherwise
    # fail the whole start list. This one may fail silently.
    & $Kurtosis service start $Enclave prometheus grafana *> $null
    $ErrorActionPreference = $previous
    Print-Links
    exit 0
}
if (-not $NoBuild) {
    & (Join-Path $PSScriptRoot 'build-docker-images.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$params = Join-Path $Root 'package\params\test.generated.yaml'
# -NoBuild skips the only producer of this file, and package\params\.gitignore
# keeps it out of every clean clone. Without this check Kurtosis fails with an
# args-file error routed into a temp log and the report below blames services.
if (-not (Test-Path -LiteralPath $params)) {
    Write-Host 'Decision: Long-running demo did not start'
    Write-Host "Blocker: $params does not exist; --no-build skipped the step that generates it."
    Write-Host 'Next action: Run pnpm demo:start without --no-build to build the images and generate the args file.'
    Write-Host 'Resource budget: No Kurtosis enclave was created.'
    exit 1
}

$runLog = Join-Path ([System.IO.Path]::GetTempPath()) 'zkdeal-demo-kurtosis.log'
Write-Host 'Preparing: local Ethereum, Blockscout, CUDA prover and startup room'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $Kurtosis run (Join-Path $Root 'package') `
    --args-file $params `
    --enclave $Enclave --verbosity BRIEF --image-download missing *> $runLog
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previous
if ($exitCode -ne 0) {
    Write-Host 'Decision: Long-running demo did not start'
    Write-Host 'Blocker: A service or the real startup proof failed its readiness gate.'
    Write-Host 'Next action: Inspect the private Kurtosis log, repair the failed service and restart with --reset.'
    Write-Host "Evidence saved: $runLog"
    Write-Host 'Resource budget: No UI readiness claim is made.'
    exit $exitCode
}
Print-Links
