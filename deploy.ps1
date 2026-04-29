<#
.SYNOPSIS
    Deploy or uninstall the Stream Deck Auto Profile Switcher plugin.

.DESCRIPTION
    Install:   stops StreamDeck, deploys the plugin, syncs profile ownership, restarts.
    Uninstall: stops StreamDeck, untags all plugin-owned profiles, removes plugin and data dirs, restarts.

    Works on native Windows and from WSL:
        Windows:  .\deploy.ps1
        WSL:      powershell.exe -File deploy.ps1

.PARAMETER NoRestart
    Skip restarting StreamDeck after the operation.

.PARAMETER SkipDeps
    Skip running npm install (install only).

.PARAMETER Uninstall
    Untag all plugin-owned profiles and remove the plugin from StreamDeck.
#>
param(
    [switch]$NoRestart,
    [switch]$SkipDeps,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$PluginUUID    = "com.lovato.autoprofileswitcher"
$LegacyUUID    = "com.lovato.windowsapps-switcher"
$PluginDir     = "com.lovato.autoprofileswitcher.sdPlugin"
$PluginsPath   = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins"
$ProfilesDir   = Join-Path $env:APPDATA "Elgato\StreamDeck\ProfilesV3"
$DataDir       = Join-Path $env:APPDATA "Elgato\StreamDeck\Data\$PluginUUID"
$StreamDeckExe = Join-Path $env:ProgramFiles "Elgato\StreamDeck\StreamDeck.exe"
$utf8NoBom     = New-Object System.Text.UTF8Encoding $false

function Untag-AllPluginProfiles {
    if (-not (Test-Path $ProfilesDir)) { return }
    foreach ($profileDir in (Get-ChildItem $ProfilesDir -Filter "*.sdProfile")) {
        $mPath = Join-Path $profileDir.FullName "manifest.json"
        if (-not (Test-Path $mPath)) { continue }
        $raw   = [System.IO.File]::ReadAllText($mPath).TrimStart([char]0xFEFF)
        $m     = $raw | ConvertFrom-Json
        if ($m.InstalledByPluginUUID -ne $PluginUUID -and $m.InstalledByPluginUUID -ne $LegacyUUID) { continue }
        $clean = [ordered]@{}
        $m.PSObject.Properties | Where-Object { $_.Name -notin @("InstalledByPluginUUID","PreconfiguredName","ReadOnly") } |
            ForEach-Object { $clean[$_.Name] = $_.Value }
        [System.IO.File]::WriteAllText($mPath, ([pscustomobject]$clean | ConvertTo-Json -Compress -Depth 10), $utf8NoBom)
        Write-Host "    Untagged: '$($m.Name)'"
    }
}

# ─── Uninstall ────────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Host "==> Stopping StreamDeck..."
    Stop-Process -Name "StreamDeck" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    Write-Host "==> Untagging plugin-owned profiles..."
    Untag-AllPluginProfiles

    Write-Host "==> Removing plugin directory..."
    $installedDir = Join-Path $PluginsPath $PluginDir
    if (Test-Path $installedDir) {
        Remove-Item -Recurse -Force $installedDir
        Write-Host "    Removed: $installedDir"
    } else {
        Write-Host "    Not found: $installedDir"
    }

    Write-Host "==> Removing data directory..."
    if (Test-Path $DataDir) {
        Remove-Item -Recurse -Force $DataDir
        Write-Host "    Removed: $DataDir"
    } else {
        Write-Host "    Not found: $DataDir"
    }

    if (-not $NoRestart) {
        Write-Host "==> Starting StreamDeck..."
        if (Test-Path $StreamDeckExe) {
            Start-Process $StreamDeckExe
            Write-Host "    StreamDeck started."
        } else {
            Write-Warning "StreamDeck.exe not found at: $StreamDeckExe"
        }
    }
    Write-Host "==> Uninstall complete."
    return
}

# ─── Install / Deploy ─────────────────────────────────────────────────────────
if (-not $SkipDeps) {
    Write-Host "==> Installing dependencies..."
    Push-Location $PluginDir
    npm install
    Pop-Location
}

Write-Host "==> Stopping StreamDeck..."
Stop-Process -Name "StreamDeck" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "==> Deploying to $PluginsPath ..."
if (-not (Test-Path $PluginsPath)) {
    New-Item -ItemType Directory -Path $PluginsPath -Force | Out-Null
}
$OldPluginDir = Join-Path $PluginsPath "com.lovato.windowsapps-switcher.sdPlugin"
if (Test-Path $OldPluginDir) {
    Remove-Item -Recurse -Force $OldPluginDir
    Write-Host "    Removed old plugin directory"
}
Copy-Item -Path $PluginDir -Destination $PluginsPath -Recurse -Force
Write-Host "    Deployed: $PluginsPath\$PluginDir"

Write-Host "==> Syncing profile ownership..."
$TagsFile    = Join-Path $DataDir "profiles.json"
$TagProfiles = @()
if (Test-Path $TagsFile) {
    $TagProfiles = Get-Content $TagsFile -Raw | ConvertFrom-Json
    Write-Host "    Targets from saved app map: $($TagProfiles -join ', ')"
} else {
    Write-Host "    No saved app map yet - profiles will be tagged on first run"
}

if (Test-Path $ProfilesDir) {
    foreach ($profileDir in (Get-ChildItem $ProfilesDir -Filter "*.sdProfile")) {
        $mPath = Join-Path $profileDir.FullName "manifest.json"
        if (-not (Test-Path $mPath)) { continue }
        $raw   = [System.IO.File]::ReadAllText($mPath).TrimStart([char]0xFEFF)
        $m     = $raw | ConvertFrom-Json
        $owner = $m.InstalledByPluginUUID
        $isOurs    = ($owner -eq $PluginUUID -or $owner -eq $LegacyUUID)
        $shouldTag = $TagProfiles -contains $m.Name

        if ($shouldTag -and -not $owner) {
            $m | Add-Member -NotePropertyName "InstalledByPluginUUID" -NotePropertyValue $PluginUUID -Force
            $m | Add-Member -NotePropertyName "PreconfiguredName"     -NotePropertyValue $m.Name     -Force
            $m | Add-Member -NotePropertyName "ReadOnly"              -NotePropertyValue $false       -Force
            [System.IO.File]::WriteAllText($mPath, ($m | ConvertTo-Json -Compress -Depth 10), $utf8NoBom)
            Write-Host "    Tagged:   '$($m.Name)'"
        } elseif ($shouldTag -and $isOurs) {
            if ($owner -eq $LegacyUUID) {
                $m | Add-Member -NotePropertyName "InstalledByPluginUUID" -NotePropertyValue $PluginUUID -Force
                [System.IO.File]::WriteAllText($mPath, ($m | ConvertTo-Json -Compress -Depth 10), $utf8NoBom)
                Write-Host "    Migrated: '$($m.Name)'"
            }
        } elseif ($isOurs -and -not $shouldTag) {
            $clean = [ordered]@{}
            $m.PSObject.Properties | Where-Object { $_.Name -notin @("InstalledByPluginUUID","PreconfiguredName","ReadOnly") } |
                ForEach-Object { $clean[$_.Name] = $_.Value }
            [System.IO.File]::WriteAllText($mPath, ([pscustomobject]$clean | ConvertTo-Json -Compress -Depth 10), $utf8NoBom)
            Write-Host "    Untagged: '$($m.Name)' (no longer in app map)"
        }
    }
}

if (-not $NoRestart) {
    Write-Host "==> Starting StreamDeck..."
    if (Test-Path $StreamDeckExe) {
        Start-Process $StreamDeckExe
        Write-Host "    StreamDeck started."
    } else {
        Write-Warning "StreamDeck.exe not found at: $StreamDeckExe"
    }
}
