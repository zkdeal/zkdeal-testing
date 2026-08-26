# Shared helpers for the scripts\run-kurtosis-*.ps1 runners.
# Kept in lockstep with scripts/lib/kurtosis.sh - change both or neither.

# Resolve the Kurtosis CLI: pinned .tools copy first (README says scripts prefer
# it), then PATH (README also documents PATH installs as supported).
function Resolve-Kurtosis {
    param([Parameter(Mandatory = $true)][string]$Root)
    $pinned = Join-Path $Root '.tools\kurtosis\kurtosis.exe'
    if (Test-Path $pinned) { return $pinned }
    $onPath = Get-Command kurtosis -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw "Kurtosis CLI not found in $Root\.tools\kurtosis\ or on PATH - see README / docs/GPU-EVIDENCE-RUNBOOK.md"
}

# The package is uploaded from the current filesystem. Reject indirection and
# record a deterministic digest so the bytes handed to Kurtosis are explicit.
function Assert-KurtosisSources {
    param([Parameter(Mandatory = $true)][string]$Root)
    foreach ($required in @('package\main.star', 'package\kurtosis.yml')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)) {
            throw "Kurtosis package source is missing: $required"
        }
    }
    $digest = (& node (Join-Path $Root 'scripts\source-manifest.mjs') $Root).Trim()
    if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw 'Could not produce the deterministic Kurtosis source manifest'
    }
    Write-Host "Kurtosis source manifest: $digest"
}

# Destructive enclave reuse is opt-in. A fixed enclave name is shared with any
# other developer/job on this host; removing it discards their logs.
function Initialize-Enclave {
    param(
        [Parameter(Mandatory = $true)][string]$Kurtosis,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$Replace
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Kurtosis enclave inspect $Name *> $null
    $exists = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prev

    if ($exists) {
        if (-not $Replace) {
            throw ("Enclave '$Name' already exists.`n" +
                "Re-run with -Replace to destroy and recreate it, or pick another name:`n" +
                "  `$env:ZKDEAL_ENCLAVE='<name>'`n" +
                "Its logs can be preserved first with: $Kurtosis enclave dump $Name <dir>")
        }
        Write-Host "==> removing existing enclave '$Name' (-Replace)"
        & $Kurtosis enclave rm $Name --force
        if ($LASTEXITCODE -ne 0) { throw "kurtosis enclave rm $Name failed ($LASTEXITCODE)" }
    }
}
