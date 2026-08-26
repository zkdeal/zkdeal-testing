# Build the zkdeal Kurtosis image set and write the generated READY args file
# `kurtosis run` consumes. There is no CPU prover fallback.
#
# `kurtosis/main.star` declares exactly three locally built images - prover,
# runner and server - plus two digest-pinned upstream L1 images it does not
# build. This script is their single producer; `kurtosis/params/test.yaml` is
# its only template. Kept in lockstep with build-docker-images.sh: every
# divergence between the pair is an OS-dependent behaviour change, because
# run-platform.mjs picks one by host OS.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
# Umbrella checkout holding the sibling component folders.
$Umbrella = Split-Path -Parent $Root
$LogRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'zkdeal-image-build'
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

function Write-Blocker {
    param([string]$Blocker, [string]$NextAction, [string]$Evidence)
    Write-Host 'Decision: Kurtosis images are not ready'
    Write-Host "Blocker: $Blocker"
    Write-Host "Next action: $NextAction"
    if ($Evidence) { Write-Host "Evidence saved: $Evidence" }
    Write-Host 'Resource budget: No Kurtosis enclave was started.'
    exit 1
}

function Invoke-Logged {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $log = Join-Path $LogRoot (($Label -replace '[^a-zA-Z0-9-]', '-') + '.log')
    Write-Host "Preparing: $Label"
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Command @Arguments *> $log
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($exitCode -ne 0) {
        Write-Blocker "$Label did not complete." 'Inspect the private build log and correct the dependency.' $log
    }
}

Push-Location $Root
try {
    # Verify the template up front, before the multi-hour CUDA, Foundry and
    # docker work: a renamed or re-indented image key must not be discovered
    # after the build, and a partially applied run must never overwrite the args
    # file Kurtosis actually runs with an incompatible key set.
    # ZKDEAL_CASE selects the example case template (base = the bootstrap
    # acceptance alone; see package/params/cases/).
    $case = if ($env:ZKDEAL_CASE) { $env:ZKDEAL_CASE } else { 'base' }
    if ($case -eq 'base') {
        $template = Join-Path $Root 'package\params\test.yaml'
        $output = Join-Path $Root 'package\params\test.generated.yaml'
    } else {
        $template = Join-Path $Root ("package\params\cases\{0}.yaml" -f $case)
        $output = Join-Path $Root ("package\params\cases\{0}.generated.yaml" -f $case)
    }
    if (-not (Test-Path -LiteralPath $template)) {
        Write-Blocker 'package/params/test.yaml does not exist.' 'Restore the checked-in Kurtosis params template.'
    }
    $text = Get-Content -LiteralPath $template -Raw
    foreach ($key in @('prover', 'runner', 'server')) {
        if ($text -notmatch "(?m)^  ${key}: NOT_BUILT$") {
            Write-Blocker "package/params/test.yaml does not declare the $key image key this builder substitutes." `
                'Realign this script with package/params/test.yaml and package/main.star.'
        }
    }

    $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader -i 0 2>$null | Select-Object -First 1)
    if ($gpuName) { $gpuName = $gpuName.Trim() }
    if (-not $gpuName) {
        Write-Blocker 'nvidia-smi did not report a device 0 on this host.' `
            'Install or repair the NVIDIA driver, then build the images again.'
    }

    # The prover kernels must match the device this stack actually proves on. A
    # hardcoded arch drifts from the shell twin and silently builds, say, sm_86
    # kernels for an sm_89 card, which invalidates any latency comparison.
    $cudaArch = $env:ZKDEAL_CUDA_ARCH
    if (-not $cudaArch) {
        $computeCap = (& nvidia-smi --query-gpu=compute_cap --format=csv,noheader -i 0 2>$null | Select-Object -First 1)
        if ($computeCap) { $cudaArch = ($computeCap -replace '[^0-9]', '') }
    }
    if ($cudaArch -notmatch '^[0-9]{2,3}$') {
        Write-Blocker 'The CUDA compute capability of device 0 could not be read.' `
            'Update the NVIDIA driver or set ZKDEAL_CUDA_ARCH to the device compute capability, e.g. 89.'
    }

    # The stack deploys these contracts, so they must be compiled by the same
    # digest-pinned image CI uses. A mutable tag makes the deployed bytecode
    # unreproducible; the pin lives in one file so it cannot drift per script.
    $foundryImage = (Get-Content -LiteralPath (Join-Path $Umbrella 'web3-protocol\contracts\foundry-image.txt') |
        Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } |
        Select-Object -First 1)
    if ($foundryImage) { $foundryImage = $foundryImage.Trim() }
    if ($foundryImage -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') {
        Write-Blocker 'web3-protocol/contracts/foundry-image.txt does not pin one image@sha256:<digest> reference.' `
            'Restore the pinned Foundry digest before compiling deployed contracts.'
    }

    $manifestScript = Join-Path $Umbrella 'prover-node\zkvm\scripts\check-lock-freshness.mjs'
    $manifestCandidate = Join-Path $Umbrella 'prover-node\zkvm\source-manifest.candidate.json'
    Invoke-Logged -Label 'deterministic source manifest' -Command 'node' -Arguments @(
        $manifestScript, '--prepare-build-input'
    )
    $observedSnapshot = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestCandidate).Hash.ToLowerInvariant()
    if ($observedSnapshot -notmatch '^[0-9a-f]{64}$') {
        Write-Blocker 'The deterministic source manifest does not have a valid SHA-256 digest.' `
            'Repair the source-manifest generator before building images.'
    }
    if ($env:ZKDEAL_SOURCE_SNAPSHOT_SHA256 -and $env:ZKDEAL_SOURCE_SNAPSHOT_SHA256 -ne $observedSnapshot) {
        Write-Blocker 'ZKDEAL_SOURCE_SNAPSHOT_SHA256 does not match the current source bytes.' `
            'Use the digest emitted by the deterministic source-manifest step.'
    }
    $revision = $observedSnapshot
    $imageTag = if ($env:ZKDEAL_IMAGE_TAG) { $env:ZKDEAL_IMAGE_TAG } else { "snapshot-$($revision.Substring(0, 12))" }
    if ($imageTag -notmatch '^[a-z0-9][a-z0-9._-]{0,127}$') {
        Write-Blocker 'ZKDEAL_IMAGE_TAG is not a valid immutable Docker tag.' `
            'Use a lowercase build identity such as recording-20260731-061500.'
    }
    $proverTag = "zkdeal-risc0-cuda-runtime:$imageTag"
    $serverTag = "zkdeal-coordinator:$imageTag"
    $runnerTag = "zkdeal-bench:$imageTag"

    Invoke-Logged -Label 'Solidity contracts' -Command 'docker' -Arguments @(
        'run', '--rm', '--entrypoint', 'forge',
        '-v', "$(Join-Path $Umbrella 'web3-protocol'):/workspace", '-w', '/workspace/contracts',
        $foundryImage,
        'build'
    )
    Invoke-Logged -Label 'single-GPU prover' -Command 'docker' -Arguments @(
        'build', '--target', 'runtime',
        '-f', (Join-Path $Umbrella 'prover-node\zkvm\docker\risc0-cuda.Dockerfile'),
        '--build-arg', "CUDA_ARCH=$cudaArch",
        '--build-arg', "SOURCE_MANIFEST_SHA256=$revision",
        '-t', $proverTag, (Join-Path $Umbrella 'prover-node')
    )
    Invoke-Logged -Label 'web console and API' -Command 'docker' -Arguments @(
        'build', '-f', (Join-Path $Umbrella 'web2-api\server\Dockerfile'), '-t', $serverTag, $Umbrella
    )
    # main.star runs packages/bench inside the coordinator image; the runner is
    # that same image under the key the package reads.
    Invoke-Logged -Label 'acceptance runner' -Command 'docker' -Arguments @(
        'tag', $serverTag, $runnerTag
    )
    Invoke-Logged -Label 'CUDA preflight' -Command 'docker' -Arguments @(
        'run', '--rm', '--gpus', 'device=0',
        '-e', 'RISC0_DEV_MODE=0',
        '-e', 'RISC0_REQUIRE_CUDA=1',
        $proverTag, 'health'
    )

    $text = $text -replace '(?m)^status: NOT_RUN$', 'status: READY'
    $text = $text -replace '(?m)^gpu_name: CURRENT_GPU_NOT_MEASURED$', ("gpu_name: `"" + ($gpuName -replace '"', '') + "`"")
    $text = $text -replace '(?m)^  prover: NOT_BUILT$', "  prover: $proverTag"
    $text = $text -replace '(?m)^  runner: NOT_BUILT$', "  runner: $runnerTag"
    $text = $text -replace '(?m)^  server: NOT_BUILT$', "  server: $serverTag"
    if ($env:ZKDEAL_PUBLIC_HOST) {
        if ($env:ZKDEAL_PUBLIC_HOST -notmatch '^[a-zA-Z0-9.-]+$') {
            Write-Blocker 'ZKDEAL_PUBLIC_HOST is not a valid host name or IP address.' `
                'Set it to the capture-visible host without a scheme or port.'
        }
        $text = $text -replace '(?m)^public_host: "127\.0\.0\.1"$', "public_host: `"$($env:ZKDEAL_PUBLIC_HOST)`""
    }
    # Per-stand prover sizing without editing tracked templates. An explicit
    # ZKDEAL_SEGMENT_PO2 always wins; otherwise the segment size is chosen from
    # the device's VRAM, because a value too large for the card OOMs the Groth16
    # wrap and produces no proof at all (see scripts/pick-segment-po2.mjs and
    # docs/GPU-SEGMENT-SIZING.md).
    if ($env:ZKDEAL_SEGMENT_PO2) {
        if ($env:ZKDEAL_SEGMENT_PO2 -notmatch '^(18|19|20|21)$') {
            Write-Blocker 'ZKDEAL_SEGMENT_PO2 must be one of 18, 19, 20, 21.' `
                'Pick the largest segment size the proving GPU fits.'
        }
        $segmentPo2 = $env:ZKDEAL_SEGMENT_PO2
    } else {
        $vramMib = (& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits -i 0 2>$null | Select-Object -First 1)
        if ($vramMib) { $vramMib = ($vramMib -replace '[^0-9]', '') }
        if ($vramMib -notmatch '^[0-9]+$') {
            Write-Blocker 'The total VRAM of device 0 could not be read to size the prover.' `
                'Update the NVIDIA driver or set ZKDEAL_SEGMENT_PO2 explicitly.'
        }
        $segmentPo2 = (& node (Join-Path $PSScriptRoot 'pick-segment-po2.mjs') $vramMib $gpuName)
        if ($LASTEXITCODE -ne 0 -or $segmentPo2 -notmatch '^(18|19|20|21)$') {
            Write-Blocker 'The segment size could not be derived from the device VRAM.' `
                'Set ZKDEAL_SEGMENT_PO2 explicitly.'
        }
    }
    $text = $text -replace '(?m)^segment_po2: "[0-9]+"$', "segment_po2: `"$segmentPo2`""
    [System.IO.File]::WriteAllText($output, $text, (New-Object System.Text.UTF8Encoding($false)))
    # This is the file Kurtosis actually runs. Every placeholder token, not just
    # the five substituted above: a renamed or re-indented template key must not
    # reach Kurtosis as an unresolvable image or an unmeasured GPU identity.
    if ($text -match 'NOT_BUILT|NOT_RUN|NOT_MEASURED|_NOT_SET') {
        Write-Blocker "$output still contains an unsubstituted template placeholder." `
            'Realign this script substitutions with kurtosis/params/test.yaml.' $output
    }

    Write-Host 'Decision: Kurtosis images are ready'
    Write-Host "Evidence: Contracts, web console, acceptance runner and one-GPU prover passed their build checks for $gpuName."
    Write-Host 'Next action: Start or resume the zkdeal enclave.'
    Write-Host "Evidence saved: $LogRoot"
    Write-Host 'Resource budget: One local CUDA device; no proof was generated by the build step.'
}
finally {
    Pop-Location
}
