<#
.SYNOPSIS
    Deploy the Stream Deck Auto Profile Switcher plugin.

.DESCRIPTION
    Installs npm dependencies, stops StreamDeck, deploys the plugin, tags
    profiles as plugin-owned, and restarts StreamDeck.

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

$PluginDir     = "com.lovato.autoprofileswitcher.sdPlugin"
$PluginsPath   = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins"
$StreamDeckExe = Join-Path $env:ProgramFiles "Elgato\StreamDeck\StreamDeck.exe"

if (-not $SkipDeps) {
    Write-Host "==> Installing dependencies..."
    Push-Location $PluginDir
    npm install
    Pop-Location
}

# Stop StreamDeck before touching the plugins directory
Write-Host "==> Stopping StreamDeck..."
Stop-Process -Name "StreamDeck" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "==> Deploying to $PluginsPath ..."
if (-not (Test-Path $PluginsPath)) {
    New-Item -ItemType Directory -Path $PluginsPath -Force | Out-Null
}
# Remove old plugin directory if present from before the rename
$OldPluginDir = Join-Path $PluginsPath "com.lovato.windowsapps-switcher.sdPlugin"
if (Test-Path $OldPluginDir) {
    Remove-Item -Recurse -Force $OldPluginDir
    Write-Host "    Removed old plugin directory"
}
Copy-Item -Path $PluginDir -Destination $PluginsPath -Recurse -Force
Write-Host "    Deployed: $PluginsPath\$PluginDir"

Write-Host "==> Syncing profile ownership..."
$ProfilesDir = Join-Path $env:APPDATA "Elgato\StreamDeck\ProfilesV3"
$PluginUUID  = "com.lovato.autoprofileswitcher"
$LegacyUUID  = "com.lovato.windowsapps-switcher"
$utf8NoBom   = New-Object System.Text.UTF8Encoding $false

# Read the target profiles saved by the plugin (profiles the app map switches to)
$TagsFile    = Join-Path $env:APPDATA "Elgato\StreamDeck\Data\$PluginUUID\profiles.json"
$TagProfiles = @()
if (Test-Path $TagsFile) {
    $TagProfiles = Get-Content $TagsFile -Raw | ConvertFrom-Json
    Write-Host "    Targets from saved app map: $($TagProfiles -join ', ')"
} else {
    Write-Host "    No saved app map yet - no profiles tagged (configure rules in the PI after first run)"
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
            # Already ours — update UUID if it was the legacy one
            if ($owner -eq $LegacyUUID) {
                $m | Add-Member -NotePropertyName "InstalledByPluginUUID" -NotePropertyValue $PluginUUID -Force
                [System.IO.File]::WriteAllText($mPath, ($m | ConvertTo-Json -Compress -Depth 10), $utf8NoBom)
                Write-Host "    Migrated: '$($m.Name)'"
            }
        } elseif ($isOurs -and -not $shouldTag) {
            # Untag - no longer in app map, let built-in Smart Profile handle it
            $clean = [ordered]@{}
            $m.PSObject.Properties | Where-Object { $_.Name -notin @("InstalledByPluginUUID","PreconfiguredName","ReadOnly") } |
                ForEach-Object { $clean[$_.Name] = $_.Value }
            [System.IO.File]::WriteAllText($mPath, ([pscustomobject]$clean | ConvertTo-Json -Compress -Depth 10), $utf8NoBom)
            Write-Host "    Untagged: '$($m.Name)' (returned to built-in Smart Profile)"
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
