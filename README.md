# StreamDeck WindowsApps Profile Switcher

> **Fixes and extends StreamDeck Smart Profile switching** — adds support for MSIX/WindowsApp packaged apps (Teams, WhatsApp, Windows Terminal) that are invisible to StreamDeck's built-in detection, and unlocks window-title-based profile rules that the built-in feature can never support.

---

## The Problem

Elgato's StreamDeck detects active applications by monitoring Win32 process executable paths. When Microsoft began shipping **Teams**, **WhatsApp**, and **Windows Terminal** as `WindowsApps` (MSIX/UWP) packages, StreamDeck lost the ability to detect them — [Elgato's own docs confirm Smart Profiles don't work with packaged apps](https://help.elgato.com/hc/en-us/articles/360053419071).

This plugin solves that, and goes further.

---

## Features

### MSIX / WindowsApps detection
Switch profiles when Teams, WhatsApp, Windows Terminal, or any other MSIX-packaged app comes into focus. Uses Win32 `GetForegroundWindow` directly — the same mechanism Windows itself uses — so it works regardless of how the app was packaged.

### Window title matching
Go beyond process names. Match on the **window title** of the focused app to create context-specific profiles:

| Process | Title contains | Profile |
|---|---|---|
| `windowsterminal` | `PowerShell` | PowerShell |
| `windowsterminal` | `Ubuntu` | WSL |
| `windowsterminal` | *(anything)* | Terminal |
| `ms-teams` | `Project X` | Teams — Project X |
| `ms-teams` | *(anything)* | Teams |

Title-specific rules always win over process-only rules, giving you a natural fallback chain.

### Hybrid mode — works alongside built-in Smart Profiles
The plugin doesn't replace StreamDeck's built-in Smart Profile feature. It **collaborates** with it:

- **Plugin handles:** MSIX apps and title-based rules
- **Built-in handles:** everything else (Chrome, VSCode, Zoom, games, etc.)

When the focused app doesn't match any rule, the plugin explicitly releases control so the built-in Smart Profile can take over. You keep all your existing Smart Profile configuration and gain new capabilities on top.

### Live profile dropdown
The Profile field in the configuration UI is a dropdown populated from your actual StreamDeck profiles — no typos, no guessing exact names. New profiles you create are picked up automatically the next time you open the configuration panel.

### Test detection
A built-in tool lets you identify the exact process name and window title of any focused app without leaving StreamDeck. Run it, switch to the target window, and the result stays visible for you to copy from. A one-click **"+ Add to app list"** button pre-fills a new rule from the detection result.

### Safe to configure
Auto-switching is paused while the configuration panel is open. Clicking on matched apps won't close the panel mid-configuration.

---

## Requirements

- **Windows 10/11**
- **StreamDeck software 6.0+**
- **Node.js 20+** (bundled with StreamDeck or [download here](https://nodejs.org/))

---

## Installation

### Option A — WSL or Linux (recommended for development)

```bash
# Install task runner once
brew install go-task

# Clone and deploy
git clone https://github.com/lovato/streamdeck-windowsapps-plugin
cd streamdeck-windowsapps-plugin
task
```

`task` installs npm dependencies, copies the plugin to StreamDeck's plugins directory, tags your profiles, and restarts StreamDeck — all in one step.

### Option B — Native Windows (PowerShell)

```powershell
git clone https://github.com/lovato/streamdeck-windowsapps-plugin
cd streamdeck-windowsapps-plugin
.\deploy.ps1
```

### Manual installation

1. Copy `com.lovato.windowsapps-switcher.sdPlugin` to `%APPDATA%\Elgato\StreamDeck\Plugins\`
2. Run `npm install` inside the plugin folder
3. Restart StreamDeck

---

## Setup

### 1. Add the action to your deck

Drag **"WindowsApps Switcher"** from the actions list onto any button on any profile. It only needs to exist somewhere — it runs as a background monitor, not as a button you press.

### 2. Open the configuration panel

Click the button you just placed. The configuration panel opens on the right.

### 3. Configure your rules

Each row maps a focused window to a StreamDeck profile:

| Column | Description |
|---|---|
| **Process** | Partial match against the process name (case-insensitive). Use **Test detection** to find this. |
| **Title match** | Optional partial match against the window title. Leave blank to match any window from that process. |
| **Profile** | Dropdown of your actual StreamDeck profiles. |

Default rules (edit or remove as needed):

| Process | Title | Profile |
|---|---|---|
| `ms-teams` | | `Teams` |
| `whatsapp` | | `WhatsApp` |
| `windowsterminal` | | `Terminal` |

### 4. Use Test detection to find process names

1. Click **Test detection** in the configuration panel
2. You have 3 seconds — switch to the app you want to match
3. The panel shows the **process name** and **window title** of that app
4. Click **+ Add to app list** to create a rule from the result, then edit as needed

### 5. Save

Click **Save**. Switching starts immediately — no restart required.

---

## How it works

```
StreamDeck starts
       │
       ▼
Plugin connects via WebSocket
       │
       ├─ Tags all your profiles as plugin-owned (required for switchToProfile)
       ├─ Loads your configured rules
       └─ Starts polling every 150ms
              │
              ▼
       GetForegroundWindow() ──► GetWindowThreadProcessId() ──► process name
                                                              └─► GetWindowText()  ──► window title
              │
              ▼
       Match against rules (title-specific first, then process-only)
              │
              ├─ Match found ──► switchToProfile("ProfileName")
              │
              └─ No match    ──► switchToProfile("") ── releases to built-in Smart Profile
```

A single persistent PowerShell process handles all Win32 API calls — no per-poll `powershell.exe` spawning overhead.

---

## Project structure

```
streamdeck-windowsapps-plugin/
├── Taskfile.yaml                          # WSL/Linux one-command deploy
├── deploy.ps1                             # Windows/WSL deployment script
└── com.lovato.windowsapps-switcher.sdPlugin/
    ├── manifest.json                      # StreamDeck plugin manifest
    ├── app.js                             # Plugin main process
    ├── package.json
    └── property-inspector/
        └── index.html                     # Configuration UI
```

---

## Adding rules for other apps

Run **Test detection**, focus the target app, and the process name and window title are shown. Click **+ Add to app list**, adjust if needed, and save.

For apps not visible in the test (background services, etc.), use PowerShell directly:

```powershell
Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Name, MainWindowTitle | Sort-Object Name
```

---

## Why not just use Smart Profiles?

Smart Profiles match apps by executable path. MSIX apps run from `C:\Program Files\WindowsApps\<package>\`, a protected directory that changes path on every app update, making reliable matching impossible. This plugin uses `GetForegroundWindow()` → process name, which is stable across updates.

Window title matching is impossible in Smart Profiles entirely — it's a process-path-only feature.

---

## License

MIT
