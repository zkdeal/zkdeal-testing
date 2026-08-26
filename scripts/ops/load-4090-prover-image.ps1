$ErrorActionPreference = 'Stop'

$Root = if ($env:ZKDEAL_DEMO_ROOT) { $env:ZKDEAL_DEMO_ROOT } else { 'C:\ProgramData\zkdeal-recording' }
$Archive = Join-Path $Root 'zkdeal-risc0-v5-recording.tar.gz'
$Tar = Join-Path $Root 'zkdeal-risc0-v5-recording.tar'
$Status = Join-Path $Root 'image-load-status.txt'
$PrivateLog = Join-Path $Root 'image-load-private.log'
$ExpectedArchiveHash = $env:ZKDEAL_PROVER_ARCHIVE_SHA256
$ExpectedTarBytes = 0L
$ArchiveHashConfigured =
    $ExpectedArchiveHash -and $ExpectedArchiveHash -match '^[0-9A-Fa-f]{64}$'
$TarLengthConfigured =
    [long]::TryParse($env:ZKDEAL_PROVER_TAR_BYTES, [ref]$ExpectedTarBytes)

if (-not $ArchiveHashConfigured -or -not $TarLengthConfigured -or $ExpectedTarBytes -le 0) {
    Set-Content -LiteralPath $Status -Value 'Decision: prover image rejected; the fresh archive hash and tar length are not configured.'
    exit 1
}

Set-Content -LiteralPath $Status -Value 'Decision: validating the transferred prover image.'
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $ExpectedArchiveHash) {
    Set-Content -LiteralPath $Status -Value 'Decision: prover image rejected; the transfer hash does not match.'
    exit 1
}

Set-Content -LiteralPath $Status -Value 'Decision: decompressing the validated prover image.'
$input = [System.IO.File]::OpenRead($Archive)
$gzip = New-Object System.IO.Compression.GZipStream(
    $input,
    [System.IO.Compression.CompressionMode]::Decompress
)
$output = [System.IO.File]::Create($Tar)
try {
    $gzip.CopyTo($output)
}
finally {
    $output.Dispose()
    $gzip.Dispose()
    $input.Dispose()
}

if ((Get-Item -LiteralPath $Tar).Length -ne $ExpectedTarBytes) {
    Set-Content -LiteralPath $Status -Value 'Decision: prover image rejected; decompressed length is invalid.'
    exit 1
}

Set-Content -LiteralPath $Status -Value 'Decision: loading the validated prover image into Docker.'
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
docker load -i $Tar *> $PrivateLog
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
if ($exitCode -ne 0) {
    Set-Content -LiteralPath $Status -Value 'Decision: Docker rejected the validated prover image.'
    exit $exitCode
}

$imageId = (docker image inspect zkdeal-risc0-cuda-runtime:v5 --format '{{.Id}}').Trim()
if ($imageId -notmatch '^sha256:[0-9a-f]{64}$') {
    Set-Content -LiteralPath $Status -Value 'Decision: Docker did not expose the loaded prover image.'
    exit 1
}

Set-Content -LiteralPath $Status -Value 'Decision: complete prover image is loaded from the hash-verified archive.'
