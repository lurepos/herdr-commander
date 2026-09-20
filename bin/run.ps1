$ErrorActionPreference = "Stop"

$PluginDir = Split-Path -Parent $PSScriptRoot
$Version = "0.2.0"
$Repos = @("lurepos/herdr-commander", "lurepos/herdr-vscode-tasks")
$BinName = "herdr-commander"

$LocalRelease = Join-Path $PluginDir "target\release\$BinName.exe"
if (Test-Path $LocalRelease) {
    & $LocalRelease @args
    exit $LASTEXITCODE
}

$LocalDebug = Join-Path $PluginDir "target\debug\$BinName.exe"
if (Test-Path $LocalDebug) {
    & $LocalDebug @args
    exit $LASTEXITCODE
}

$StateDir = $env:HERDR_PLUGIN_STATE_DIR
if (-not $StateDir) {
    $StateDir = Join-Path $env:LOCALAPPDATA "herdr\plugins\herdr.commander"
}
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$CachedBin = Join-Path $StateDir "$BinName-v$Version.exe"

if (Test-Path $CachedBin) {
    & $CachedBin @args
    exit $LASTEXITCODE
}

# Download release
$Target = "x86_64-pc-windows-msvc"
$TmpZip = Join-Path $StateDir "$BinName.zip"

foreach ($Repo in $Repos) {
    $Url = "https://github.com/$Repo/releases/download/v$Version/$BinName-$Target.zip"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $TmpZip -UseBasicParsing
        Expand-Archive -Path $TmpZip -DestinationPath $StateDir -Force
        Remove-Item $TmpZip -Force
        $Extracted = Join-Path $StateDir "$BinName.exe"
        if (Test-Path $Extracted) {
            Move-Item -Path $Extracted -Destination $CachedBin -Force
            & $CachedBin @args
            exit $LASTEXITCODE
        }
    } catch {
        # Continue to fallback repo
    }
}

if (Get-Command cargo -ErrorAction SilentlyContinue) {
    cargo build --release --manifest-path (Join-Path $PluginDir "Cargo.toml")
    if (Test-Path $LocalRelease) {
        & $LocalRelease @args
        exit $LASTEXITCODE
    }
}

Write-Error "Could not find or build herdr-commander."
exit 1
