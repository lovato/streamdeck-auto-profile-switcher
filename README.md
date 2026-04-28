# StreamDeck WindowsApps Profile Switcher

> **Fixes StreamDeck Smart Profile auto-switching for MSIX/WindowsApp packaged apps** — including Microsoft Teams, WhatsApp, and Windows Terminal — which are invisible to StreamDeck's built-in app detection.

---

## The Problem

Elgato's StreamDeck software detects active applications to auto-switch Smart Profiles by monitoring Win32 processes. When Microsoft began shipping **Teams**, **WhatsApp**, and **Windows Terminal** as `WindowsApps` packages (MSIX/UWP-style), StreamDeck lost the ability to detect them. [Elgato's own docs confirm Smart Profiles don't work with UWP/packaged apps](https://help.elgato.com/hc/en-us/articles/360053419071).

This repo contains a **native StreamDeck plugin** (Node.js) that solves this at the right level — by polling the active foreground window via Win32 API (through PowerShell) and calling `switchToProfile` directly over the StreamDeck WebSocket protocol.

---

## How It Works

```
[Plugin: app.js]
      │
      │  polls Win32 GetForegroundWindow() every 500ms via PowerShell
      ▼
 Detects Teams / WhatsApp / Terminal (or any custom app you configure)
      │
      │  sends switchToProfile over WebSocket
      ▼
[StreamDeck software]
      │
      │  switches to the correct profile
      ▼
 Your deck shows the right layout ✓
```

---

## Requirements

- **Windows 10/11**
- **StreamDeck software 6.0+**
- **Node.js 20+** — [download here](https://nodejs.org/)

---

## Installation

### Step 1 — Install dependencies

```bash
cd com.lovato.windowsapps-switcher.sdPlugin
npm install
```

### Step 2 — Install the plugin into StreamDeck

Copy the entire `com.lovato.windowsapps-switcher.sdPlugin` folder to your StreamDeck plugins directory:

```
%APPDATA%\Elgato\StreamDeck\Plugins\
```

So the final path looks like:

```
%APPDATA%\Elgato\StreamDeck\Plugins\com.lovato.windowsapps-switcher.sdPlugin\
```

### Step 3 — Restart StreamDeck software

Quit and reopen the StreamDeck app. The plugin will appear under **Custom** actions in the sidebar.

### Step 4 — Add the action to any profile

Drag the **"WindowsApps Switcher"** action onto any button on any profile. It only needs to exist somewhere — it doesn't matter which profile or which button. The monitoring runs in the background.

### Step 5 — Name your profiles correctly

The plugin switches by profile name. Make sure your profiles in StreamDeck Settings are named:

| App              | Default profile name |
|------------------|----------------------|
| Microsoft Teams  | `Teams`              |
| WhatsApp         | `WhatsApp`           |
| Windows Terminal | `Terminal`           |

You can rename them — just update the mapping in the Property Inspector.

### Step 6 — Configure (optional)

Click the action button you placed in Step 4 to open the **Property Inspector**. There you can:

- Change which process name maps to which profile
- Add more apps
- Click **Test detection** to see what process is currently active

---

## Finding the correct process name

If a profile isn't switching, the process name on your system might differ (especially after a Teams or WhatsApp update).

**Easiest way:** focus the app you want to detect, then click **"Test detection"** in the Property Inspector. It will show you the exact process name the plugin sees.

**Manual way (PowerShell):**

```powershell
Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Name, MainWindowTitle | Sort-Object Name
```

---

## Project Structure

```
com.lovato.windowsapps-switcher.sdPlugin/
├── manifest.json              # StreamDeck plugin manifest
├── app.js                     # Plugin main process (Node.js + WebSocket)
├── package.json               # npm dependencies (ws)
├── property-inspector/
│   └── index.html             # Configuration UI shown in StreamDeck
└── icons/                     # Plugin icons (add your own PNGs here)
```

---

## Why Not Use Smart Profiles?

Because they [officially don't support UWP/packaged apps](https://help.elgato.com/hc/en-us/articles/360053419071-Elgato-Stream-Deck-Smart-Profiles). Microsoft's move to distribute Teams, WhatsApp, and Terminal as `WindowsApps` packages made them invisible to StreamDeck's process monitor. This plugin solves that at the OS level using the Win32 `GetForegroundWindow` API.

---

## License

MIT
