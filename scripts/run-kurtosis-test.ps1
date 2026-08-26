# Run the Kurtosis acceptance stack on geth/Lighthouse + a real CUDA prover
# and gate the evidence artifact it emits. Kept in lockstep with the shell twin;
# run-platform.mjs picks one by host OS.
param(
  [switch]$Replace,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$RemainingArguments
)
$ErrorActionPreference = "Stop"
# run-platform.mjs forwards argv verbatim, so the documented `--replace` arrives
# as an unbound positional and PowerShell aborts with a parameter-binding error.
# Map it the way run-kurtosis-demo.ps1 does.
if ($RemainingArguments -contains '--replace') { $Replace = $true }
$Case = if ($env:ZKDEAL_CASE) { $env:ZKDEAL_CASE } else { 'base' }
$expectCase = $false
foreach ($argument in $RemainingArguments) {
  if ($expectCase) { $Case = $argument; $expectCase = $false; continue }
  # Reject the way run-kurtosis-test.sh does - a named line on stderr and exit 2
  # - rather than throwing, which prints a PowerShell stack trace and exits 1.
  if ($argument -eq '--replace') { continue }
  if ($argument -eq '--case') { $expectCase = $true; continue }
  if ($argument -like '--case=*') { $Case = $argument.Substring(7); continue }
  [Console]::Error.WriteLine("unknown argument: $argument")
  exit 2
}
if ($expectCase) { [Console]::Error.WriteLine('--case needs a value'); exit 2 }
$env:ZKDEAL_CASE = $Case
$Root = Split-Path -Parent $PSScriptRoot
$ArgsFile = if ($Case -eq 'base') {
  Join-Path $Root 'package\params\test.generated.yaml'
} else {
  Join-Path $Root ("package\params\cases\{0}.generated.yaml" -f $Case)
}
. (Join-Path $PSScriptRoot 'lib\kurtosis.ps1')

# The enclave run is worthless without the validator it ends with. Check that
# packages/bench still defines it before reserving the GPU rather than after.
$BenchScripts = (Get-Content -LiteralPath (Join-Path $Root 'packages\bench\package.json') -Raw |
  ConvertFrom-Json).scripts
if (-not $BenchScripts.'validate') {
  [Console]::Error.WriteLine('Decision: The acceptance run was not started')
  [Console]::Error.WriteLine('Blocker: packages/bench no longer defines the validate evidence validator this runner ends with.')
  [Console]::Error.WriteLine('Next action: Restore the evidence validator before running the acceptance gate.')
  [Console]::Error.WriteLine('Resource budget: No image was built, no GPU was reserved and no enclave was created.')
  exit 1
}

$Enclave = if ($env:ZKDEAL_ENCLAVE) {
  $env:ZKDEAL_ENCLAVE
} else {
  "zkdeal-test-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))-$PID"
}
# Non-base cases end with a second validator over the example evidence; check
# it up front too (lockstep with the .sh twin) instead of ~40 minutes in.
if ($Case -ne 'base' -and -not $BenchScripts.'validate:example') {
  [Console]::Error.WriteLine('Decision: The example acceptance run was not started')
  [Console]::Error.WriteLine('Blocker: packages/bench no longer defines the validate:example evidence validator.')
  exit 1
}
$Kurtosis = Resolve-Kurtosis -Root $Root
Assert-KurtosisSources -Root $Root
& (Join-Path $PSScriptRoot 'build-docker-images.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Initialize-Enclave -Kurtosis $Kurtosis -Name $Enclave -Replace:$Replace
$EvidenceDir = if ($env:ZKDEAL_INTEGRATION_EVIDENCE_DIR) {
  [IO.Path]::GetFullPath($env:ZKDEAL_INTEGRATION_EVIDENCE_DIR)
} else {
  Join-Path $Root "test-results\hosting-gpu-integration\$Enclave"
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$OutLog = Join-Path $Root 'kurtosis-test-out.log'
$ErrLog = Join-Path $Root 'kurtosis-test-err.log'
$Run = Start-Process -FilePath $Kurtosis -ArgumentList @(
  'run', (Join-Path $Root 'package'),
  '--args-file', $ArgsFile,
  '--enclave', $Enclave,
  '--verbosity', 'detailed',
  '--image-download', 'missing'
) -WorkingDirectory $Root -WindowStyle Hidden -Wait -PassThru `
  -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
if ($Run.ExitCode -ne 0) {
  $OriginalExit = $Run.ExitCode
  Write-Host "Kurtosis acceptance failed (exit $OriginalExit); preserving logs and enclave for inspection."
  $PreviousNativePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    & $Kurtosis enclave inspect $Enclave 2>&1 |
      Out-File -LiteralPath (Join-Path $EvidenceDir 'enclave-inspect.txt') -Encoding utf8
  } catch {
    $_ | Out-File -LiteralPath (Join-Path $EvidenceDir 'enclave-inspect.txt') -Encoding utf8 -Append
  }
  try {
    & $Kurtosis service logs $Enclave --all-services --all 2>&1 |
      Out-File -LiteralPath (Join-Path $EvidenceDir 'all-service-logs.txt') -Encoding utf8
  } catch {
    $_ | Out-File -LiteralPath (Join-Path $EvidenceDir 'all-service-logs.txt') -Encoding utf8 -Append
  }
  try {
    & $Kurtosis enclave dump $Enclave (Join-Path $EvidenceDir 'enclave-dump') 2>&1 |
      Out-File -LiteralPath (Join-Path $EvidenceDir 'enclave-dump-command.txt') -Encoding utf8
  } catch {
    $_ | Out-File -LiteralPath (Join-Path $EvidenceDir 'enclave-dump-command.txt') -Encoding utf8 -Append
  }
  $PSNativeCommandUseErrorActionPreference = $PreviousNativePreference
  Copy-Item -LiteralPath $OutLog -Destination $EvidenceDir -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $ErrLog -Destination $EvidenceDir -Force -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $OutLog -Tail 100 -ErrorAction SilentlyContinue
  exit $OriginalExit
}

# The one artifact kurtosis/main.star stores (StoreSpec zkdeal-v5-kurtosis-evidence).
& $Kurtosis files download $Enclave zkdeal-v5-kurtosis-evidence $EvidenceDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$Evidence = Get-ChildItem -LiteralPath $EvidenceDir -Recurse -Filter 'v5-kurtosis-evidence.json' |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $Evidence) { throw 'the acceptance evidence artifact was not downloaded' }
& pnpm --filter '@zkdeal/bench' validate $Evidence.FullName
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Case -ne 'base') {
  & $Kurtosis files download $Enclave ("zkdeal-example-{0}-evidence" -f $Case) $EvidenceDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $ExampleEvidence = Get-ChildItem -LiteralPath $EvidenceDir -Recurse -Filter 'example-evidence.json' |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $ExampleEvidence) { throw "the $Case example evidence artifact was not downloaded" }
  & pnpm --filter '@zkdeal/bench' validate:example $ExampleEvidence.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Copy-Item -LiteralPath $ArgsFile -Destination $EvidenceDir -Force
Copy-Item -LiteralPath (Join-Path $Root '..\prover-node\zkvm\artifacts.lock.json') -Destination $EvidenceDir -Force
Write-Host "==> real-proof CUDA/L1 acceptance evidence validated (case: $Case): $($Evidence.FullName)"
# Best-effort pointer at the enclave's browser surfaces on their fixed host
# ports (main.star / observability.star). Tolerant of absence and never allowed
# to affect the exit code of a validated acceptance run.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$links = @()
& $Kurtosis port print $Enclave explorer http *> $null
if ($LASTEXITCODE -eq 0) { $links += 'L1 explorer: http://127.0.0.1:3200' }
& $Kurtosis port print $Enclave grafana http *> $null
if ($LASTEXITCODE -eq 0) { $links += 'Grafana: http://127.0.0.1:3300' }
& $Kurtosis port print $Enclave prometheus http *> $null
if ($LASTEXITCODE -eq 0) { $links += 'Prometheus: http://127.0.0.1:9090' }
$ErrorActionPreference = $previous
if ($links.Count -gt 0) { Write-Host ($links -join '  ') }
exit 0
