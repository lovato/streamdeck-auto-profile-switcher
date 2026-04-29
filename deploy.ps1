<#
.SYNOPSIS
    Deploy the Stream Deck Windows Apps Switcher plugin.

.DESCRIPTION
    Installs npm dependencies, copies the plugin to the StreamDeck plugins
    directory, and restarts StreamDeck.

    Works on native Windows and from WSL:
        Windows:  .\deploy.ps1
        WSL:      powershell.exe -File deploy.ps1

.PARAMETER NoRestart
    Skip restarting StreamDeck after deployment.

.PARAMETER SkipDeps
    Skip running npm install (useful when deps were already installed).

#>
param(
    [switch]$NoRestart,
    [switch]$SkipDeps
)

$ErrorActionPreference = "Stop"

$PluginDir     = "com.lovato.windowsapps-switcher.sdPlugin"
$PluginsPath   = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins"
$StreamDeckExe = Join-Path $env:ProgramFiles "Elgato\StreamDeck\StreamDeck.exe"

if (-not $SkipDeps) {
    Write-Host "==> Installing dependencies..."
    Push-Location $PluginDir
    npm install
    Pop-Location
}

Write-Host "==> Deploying to $PluginsPath ..."
if (-not (Test-Path $PluginsPath)) {
    New-Item -ItemType Directory -Path $PluginsPath -Force | Out-Null
}
Copy-Item -Path $PluginDir -Destination $PluginsPath -Recurse -Force
Write-Host "    Deployed: $PluginsPath\$PluginDir"

Write-Host "==> Tagging profiles as plugin-owned..."
$ProfilesDir = Join-Path $env:APPDATA "Elgato\StreamDeck\ProfilesV3"
$PluginUUID  = "com.lovato.windowsapps-switcher"
$utf8NoBom   = New-Object System.Text.UTF8Encoding $false
if (Test-Path $ProfilesDir) {
    foreach ($profileDir in (Get-ChildItem $ProfilesDir -Filter "*.sdProfile")) {
        $mPath = Join-Path $profileDir.FullName "manifest.json"
        if (-not (Test-Path $mPath)) { continue }
        $raw = [System.IO.File]::ReadAllText($mPath).TrimStart([char]0xFEFF)
        $m   = $raw | ConvertFrom-Json
        if ($m.InstalledByPluginUUID -and $m.InstalledByPluginUUID -ne $PluginUUID) { continue }
        $m | Add-Member -NotePropertyName "InstalledByPluginUUID" -NotePropertyValue $PluginUUID -Force
        $m | Add-Member -NotePropertyName "PreconfiguredName"     -NotePropertyValue $m.Name     -Force
        $m | Add-Member -NotePropertyName "ReadOnly"              -NotePropertyValue $false       -Force
        [System.IO.File]::WriteAllText($mPath, ($m | ConvertTo-Json -Compress -Depth 10), $utf8NoBom)
        Write-Host "    Tagged: '$($m.Name)'"
    }
}

if (-not $NoRestart) {
    Write-Host "==> Restarting StreamDeck..."
    Stop-Process -Name "StreamDeck" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (Test-Path $StreamDeckExe) {
        Start-Process $StreamDeckExe
        Write-Host "    StreamDeck restarted."
    } else {
        Write-Warning "StreamDeck.exe not found at: $StreamDeckExe"
    }
}
