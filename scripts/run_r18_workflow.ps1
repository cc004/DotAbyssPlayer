param(
    [string]$Profile = "android-dmm-r18",
    [string]$BundleRoot = "workspace/bundles/android-dmm-r18",
    [string]$PlayerDataRoot = "src/AdvPlayer/data_r18_all",
    [string]$StoryPrefix = "",
    [string]$AppVersion = "1.1.2",
    [switch]$SkipAudio,
    [switch]$SkipSharedAssets
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$charastandRoot = Join-Path $BundleRoot "r18-only-charastand"
$emotionRoot = Join-Path $BundleRoot "general-ui/assets/assets/project/lazyassets/general/ui/emotion/charastand/prefabs/emo"
$backgroundRoot = Join-Path $BundleRoot "general-ui-bg-novel/assets/assets/project/lazyassets/general/ui/bg/novel"
$seRoot = Join-Path $BundleRoot "general-sound-cri/assets/assets/project/lazyassets/general/sound/cri/pc/workunit/novel/se"
$storyRoot = Join-Path $PlayerDataRoot "stories"

$downloadArgs = @(
    "run", "--project", "src/DotAbyssClient", "--",
    "download",
    "--profile", $Profile,
    "--app-version", $AppVersion,
    "-o", $BundleRoot,
    "--write-catalog-json"
)

Write-Host "Downloading catalog and bundles..."
dotnet @downloadArgs

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

Write-Host "Extracting story data..."
python @extractArgs

if (-not $SkipSharedAssets) {
    Write-Host "Extracting shared character stands..."
    python tools/extract_charastand_assets.py --story-root $storyRoot --bundle-root $charastandRoot --emotion-root $emotionRoot

    Write-Host "Extracting shared backgrounds..."
    python tools/extract_bg_assets.py --story-root $storyRoot --bundle-root $backgroundRoot

    if (-not $SkipAudio) {
        Write-Host "Extracting shared SE..."
        python tools/extract_global_se_assets.py --story-root $storyRoot --bundle-root $seRoot

        Write-Host "Converting wav to ogg..."
        python tools/convert_wav_audio_to_ogg.py
    }
}
