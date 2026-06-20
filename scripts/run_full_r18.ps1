param(
    [string]$Profile = "android-dmm-r18",
    [string]$AppVersion = "1.1.2",
    [string]$BundleRoot = "workspace/bundles/android-dmm-r18",
    [string]$PlayerDataRoot = "src/AdvPlayer/data_r18_all",
    [string]$StoryPrefix = "",
    [int]$Parallel = 8,
    [int]$Retries = 3,
    [int]$Limit = 0,
    [string]$Python = "",
    [string]$Vgmstream = "",
    [int]$ServePort = 8777,
    [switch]$DryRun,
    [switch]$SkipDownload,
    [switch]$SkipExtract,
    [switch]$SkipAudio,
    [switch]$SkipSharedAssets,
    [switch]$SkipVerify,
    [switch]$OverwriteCatalog,
    [switch]$OverwriteBundles,
    [switch]$Serve
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Step {
    param(
        [string]$Title,
        [string]$Command,
        [string[]]$Arguments
    )
    Write-Host ""
    Write-Host "==> $Title" -ForegroundColor Cyan
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

function Resolve-PythonCommand {
    if ($Python -ne "") {
        return $Python
    }
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        return "py"
    }
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        return "python"
    }
    throw "Python not found. Install Python 3.10+ or pass -Python <path>."
}

function New-PythonVenv {
    if ($pythonCommand -eq "py") {
        foreach ($version in @("-3.11", "-3.10", "-3.9", "-3.8")) {
            Write-Host ""
            Write-Host "==> Create Python venv with py $version" -ForegroundColor Cyan
            & $pythonCommand $version -m venv ".venv"
            if ($LASTEXITCODE -eq 0 -and (Test-Path $venvPython)) {
                return
            }
        }
        throw "Could not create venv with py launcher. Install Python 3.10+ or pass -Python <path>."
    }
    Invoke-Step -Title "Create Python venv" -Command $pythonCommand -Arguments @("-m", "venv", ".venv")
}

function Invoke-Python {
    param([string[]]$Arguments)
    Invoke-Step -Title "python $($Arguments -join ' ')" -Command $venvPython -Arguments $Arguments
}

$pythonCommand = Resolve-PythonCommand
$venvRoot = Join-Path $repoRoot ".venv"
$venvPython = Join-Path $venvRoot "Scripts/python.exe"

if (-not (Test-Path $venvPython)) {
    New-PythonVenv
}

Invoke-Python @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Python @("-m", "pip", "install", "-r", "requirements.txt")

Invoke-Step -Title "Build DotAbyssClient" -Command "dotnet" -Arguments @(
    "build",
    "src/DotAbyssClient/DotAbyssClient.csproj"
)

$charastandRoot = Join-Path $BundleRoot "r18-only-charastand"
$emotionRoot = Join-Path $BundleRoot "general-ui/assets/assets/project/lazyassets/general/ui/emotion/charastand/prefabs/emo"
$backgroundRoot = Join-Path $BundleRoot "general-ui-bg-novel/assets/assets/project/lazyassets/general/ui/bg/novel"
$seRoot = Join-Path $BundleRoot "general-sound-cri/assets/assets/project/lazyassets/general/sound/cri/pc/workunit/novel/se"
$storyRoot = Join-Path $PlayerDataRoot "stories"

if (-not $SkipDownload) {
    $downloadArgs = @(
        "run", "--project", "src/DotAbyssClient", "--",
        "download",
        "--profile", $Profile,
        "--app-version", $AppVersion,
        "-o", $BundleRoot,
        "--parallel", "$Parallel",
        "--retries", "$Retries",
        "--write-catalog-json"
    )
    if ($Limit -gt 0) {
        $downloadArgs += @("--limit", "$Limit")
    }
    if ($DryRun) {
        $downloadArgs += "--dry-run"
    }
    if ($OverwriteCatalog) {
        $downloadArgs += "--overwrite-catalog"
    }
    if ($OverwriteBundles) {
        $downloadArgs += "--overwrite"
    }
    Invoke-Step -Title "Download catalog and bundles" -Command "dotnet" -Arguments $downloadArgs
}

if ($DryRun -and -not $SkipExtract) {
    Write-Host ""
    Write-Host "DryRun selected: skipping extraction because bundle payloads were not downloaded." -ForegroundColor Yellow
}

if (-not $DryRun -and -not $SkipExtract) {
    $extractArgs = @(
        "tools/adv_extract.py",
        "--scan-all",
        "--bundle-root", $BundleRoot,
        "--output", $PlayerDataRoot
    )
    if ($StoryPrefix -ne "") {
        $extractArgs += @("--story-prefix", $StoryPrefix)
    }
    if ($SkipAudio) {
        $extractArgs += "--no-audio"
    }
    if ($Vgmstream -ne "") {
        $extractArgs += @("--vgmstream", $Vgmstream)
    }
    Invoke-Python $extractArgs

    if (-not $SkipSharedAssets) {
        Invoke-Python @(
            "tools/extract_charastand_assets.py",
            "--story-root", $storyRoot,
            "--bundle-root", $charastandRoot,
            "--emotion-root", $emotionRoot
        )

        Invoke-Python @(
            "tools/extract_bg_assets.py",
            "--story-root", $storyRoot,
            "--bundle-root", $backgroundRoot
        )

        if (-not $SkipAudio) {
            $seArgs = @(
                "tools/extract_global_se_assets.py",
                "--story-root", $storyRoot,
                "--bundle-root", $seRoot
            )
            if ($Vgmstream -ne "") {
                $seArgs += @("--vgmstream", $Vgmstream)
            }
            Invoke-Python $seArgs
            Invoke-Python @("tools/convert_wav_audio_to_ogg.py")
        }
    }

    if (-not $SkipVerify) {
        Invoke-Python @(
            "tools/verify_advplayer_data.py",
            "--data-root", $PlayerDataRoot,
            "--json", "workspace/verify_advplayer_data.json"
        )
    }
}

if ($Serve) {
    Invoke-Python @("scripts/serve_advplayer.py", "--port", "$ServePort")
}

Write-Host ""
Write-Host "Full R18 workflow finished." -ForegroundColor Green
