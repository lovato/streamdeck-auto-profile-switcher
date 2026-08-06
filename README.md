# StreamDeck Auto Profile Switcher

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

## User Setup

### 1. Install the plugin

Install the latest file manually or download it from the [Elgato Marketplace](https://marketplace.elgato.com/stream-deck/plugins).

### 1. Add the action to your deck

Drag **"Auto Profile Switcher"** from the actions list onto any button on any profile. It only needs to exist somewhere — it runs as a background monitor, not as a button you press. I'd recommend placing it on a dedicated "Settings" profile or somewhere out of the way to avoid accidental clicks, but it's up to you.

### 2. Create a new profile

To try it, create a new profile with a different icon or something so you can see when it switches. You can create as many profiles as you want — the plugin will show them all in the dropdown when configuring rules.

### 3. Open another tool

We will use Calculator in this example to test the detection and create rules in the next steps. Just have it open and visible on your desktop.

### 4. Test Detection

Click the button you placed in step 1, then click **Test detection** in the configuration panel. You have 3 seconds to switch to the Calculator window. After that, the panel will show you the process name and window title of the focused app. This is how you find the exact process name to use in your rules.

### 5. Add rules

Now that you know the process name for Calculator, you can add a rule to switch to a specific profile whenever Calculator is focused. Click **+ Add this to App List** in the configuration panel to create a new rule pre-filled with the detected process name and window title. Adjust the profile dropdown to select the profile you want to switch to when Calculator is active.

### 6. Switch Target Profile

Go to the Plugin Settings and change the profile to the one you just created to switch to when Calculator is active. And hit *Save* and Close Elgato StreamDeck. If you leave it open, there is no auto-switching since it is considered you are in dev mode.

### 7. Patch the Profile

If this didn't work alone, you are required to "take over" the profile by tagging it as plugin-owned. To do that, get to the end of the configuration panel and click the button **Patch** next to the profile name. This is required for the plugin to have permission to switch to that profile. 

### 8. Restart StreamDeck

After patching, you need to restart StreamDeck for the changes to take effect. You must quit the application, and not just close the window, to ensure a full restart. You can go to the icon on the system tray, right-click it, and select "Quit StreamDeck". Then start StreamDeck again from the Start menu or desktop shortcut.

The moment you do that, because StreamDeck will be opened, the plugin will not yet start switching profiles. Now, you can just hit the **Close** button to get the StreamDeck app minimized to the system tray.

Switch to Calculator and see the profile switch in action!

---

## Developer Setup

### Option A — WSL or Linux (recommended for development)

```bash
# Install task runner once
brew install go-task

# Clone and deploy
git clone https://github.com/lovato/streamdeck-auto-profile-switcher
cd streamdeck-windowsapps-plugin
task deploy
```

`task deploy` installs npm dependencies, bundles the plugin, copies it to StreamDeck's plugins directory, and restarts StreamDeck — all in one step.

### Option B — Native Windows (PowerShell)

```powershell
git clone https://github.com/lovato/streamdeck-auto-profile-switcher
cd streamdeck-windowsapps-plugin
.\deploy.ps1
```

### Manual installation

1. Copy `com.lovato.autoprofileswitcher.sdPlugin` to `%APPDATA%\Elgato\StreamDeck\Plugins\`
2. Run `npm install` inside the plugin folder
3. Run `npx @vercel/ncc build app.js --out build/` inside the plugin folder
4. Restart StreamDeck

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
└── com.lovato.autoprofileswitcher.sdPlugin/
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

## Available tasks

Run `task` with no arguments to list all available tasks.

| Task | Description |
|---|---|
| `task deploy` | Install deps, build, copy to StreamDeck plugins folder, restart StreamDeck |
| `task deploy:quick` | Build and deploy (skip `npm install`) |
| `task deploy:no-restart` | Build and deploy without restarting StreamDeck |
| `task uninstall` | Untag all plugin-owned profiles and remove the plugin |
| `task deps` | Install npm dependencies |
| `task build` | Bundle `app.js` + dependencies → `build/index.js` via ncc |
| `task pack` | Build and package into `dist/*.streamDeckPlugin` |
| `task pack:release` | Build and package using the version from the latest git tag |
| `task restart` | Restart the StreamDeck application |

### Packaging for distribution

To create a `.streamDeckPlugin` installer file (for sharing or Marketplace submission):

```bash
task pack
# → dist/com.lovato.autoprofileswitcher.streamDeckPlugin
```

The installer can be shared directly with users (double-click to install) or submitted to the Elgato Marketplace.

### Versioned releases

Tag a git release, then package with the version embedded:

```bash
git tag v1.1.0 && git push --tags
task pack:release
# → dist/com.lovato.autoprofileswitcher.streamDeckPlugin (v1.1.0)
```

---

## Submitting to Marketplace

1. **Create a Maker account** at [maker.elgato.com](https://maker.elgato.com) and sign the Maker Agreement.
2. **Package the plugin**: `task pack:release`
3. **Upload** the `.streamDeckPlugin` file to Maker Console → Create product → Stream Deck plugin.
4. **Fill in details**: name, description, tags, pricing, screenshots, app icon.
5. **Submit for review**. Review typically takes 4–10 business days.

For more details, see the [Elgato Marketplace documentation](https://docs.elgato.com/marketplace/become-a-maker/).

---

## License

MIT

