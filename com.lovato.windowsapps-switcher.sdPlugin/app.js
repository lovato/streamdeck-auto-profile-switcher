/**
 * StreamDeck WindowsApps Profile Switcher
 * =========================================
 * Fixes Smart Profile auto-switching for MSIX/WindowsApp packaged apps
 * (Teams, WhatsApp, Windows Terminal) which are invisible to StreamDeck's
 * built-in app detection.
 *
 * How it works:
 *  1. Connects to StreamDeck via WebSocket (standard plugin protocol)
 *  2. Polls the active foreground window every 500ms via PowerShell
 *  3. When a configured WindowsApp is detected, sends switchToProfile
 *  4. Tracks last profile to avoid redundant switches
 */

const WebSocket = require("ws");
const { execSync } = require("child_process");

// ─── StreamDeck connection args ───────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const PORT          = getArg("-port");
const PLUGIN_UUID   = getArg("-pluginUUID");
const REGISTER_EVT  = getArg("-registerEvent");
const INFO          = JSON.parse(getArg("-info") || "{}");

// ─── Configuration ────────────────────────────────────────────────────────────
// Poll interval in ms — lower = more responsive, slightly more CPU
const POLL_INTERVAL_MS = 500;

// Map of: process name fragment (lowercase) → profile name (must match exactly
// what you named the profile in StreamDeck Settings → Profiles)
// Users can override this via the Property Inspector UI / global settings.
const DEFAULT_APP_MAP = [
  { match: "ms-teams",         profile: "Teams"    },
  { match: "whatsapp",         profile: "WhatsApp" },
  { match: "windowsterminal",  profile: "Terminal" },
];

// ─── State ────────────────────────────────────────────────────────────────────
let ws             = null;
let deviceId       = null;
let actionContext  = null;
let lastProfile    = null;
let appMap         = DEFAULT_APP_MAP;
let pollTimer      = null;
let globalSettings = {};

// ─── PowerShell: get foreground process name ──────────────────────────────────
function getActiveProcessName() {
  const ps = `
    Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class Win32 {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
      }
"@
    $hwnd = [Win32]::GetForegroundWindow()
    $pid  = 0
    [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
    if ($pid -gt 0) {
      (Get-Process -Id $pid -ErrorAction SilentlyContinue).Name
    }
  `.trim();

  try {
    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`,
      { timeout: 3000, windowsHide: true }
    ).toString().trim();
    return result.toLowerCase();
  } catch {
    return "";
  }
}

// ─── Profile detection ────────────────────────────────────────────────────────
function detectProfile(procName) {
  for (const entry of appMap) {
    if (procName.includes(entry.match.toLowerCase())) {
      return entry.profile;
    }
  }
  return null;
}

// ─── StreamDeck WebSocket send helpers ───────────────────────────────────────
function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function switchToProfile(profileName) {
  if (!deviceId) return;
  send({
    event:   "switchToProfile",
    context: PLUGIN_UUID,
    device:  deviceId,
    payload: { profile: profileName },
  });
}

function setGlobalSettings(settings) {
  send({
    event:   "setGlobalSettings",
    context: PLUGIN_UUID,
    payload: settings,
  });
}

function getGlobalSettings() {
  send({
    event:   "getGlobalSettings",
    context: PLUGIN_UUID,
  });
}

function logMessage(msg) {
  send({
    event:   "logMessage",
    context: actionContext || PLUGIN_UUID,
    payload: { message: `[WindowsApps Switcher] ${msg}` },
  });
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const proc    = getActiveProcessName();
    const profile = detectProfile(proc);

    if (profile && profile !== lastProfile) {
      lastProfile = profile;
      logMessage(`Detected "${proc}" → switching to profile "${profile}"`);
      switchToProfile(profile);
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── Apply settings from global store ────────────────────────────────────────
function applySettings(settings) {
  globalSettings = settings || {};

  // If user configured a custom app map via Property Inspector, use it
  if (Array.isArray(globalSettings.appMap) && globalSettings.appMap.length > 0) {
    appMap = globalSettings.appMap;
    logMessage(`Loaded custom app map with ${appMap.length} entries`);
  } else {
    appMap = DEFAULT_APP_MAP;
  }
}

// ─── WebSocket connection ─────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}`);

  ws.on("open", () => {
    // Register with StreamDeck
    send({ event: REGISTER_EVT, uuid: PLUGIN_UUID });
    // Ask for saved settings
    getGlobalSettings();
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      // StreamDeck connected a device — store its ID for switchToProfile calls
      case "deviceDidConnect":
        if (!deviceId) {
          deviceId = msg.device;
          logMessage(`Device connected: ${deviceId}`);
          startPolling();
        }
        break;

      case "deviceDidDisconnect":
        if (msg.device === deviceId) {
          deviceId = null;
          stopPolling();
        }
        break;

      // Action placed on the deck — store context
      case "willAppear":
        actionContext = msg.context;
        if (!deviceId) deviceId = msg.device;
        if (!pollTimer) startPolling();
        break;

      case "willDisappear":
        // Don't stop polling — other profiles/pages still need it
        break;

      // Settings loaded from StreamDeck storage
      case "didReceiveGlobalSettings":
        applySettings(msg.payload?.settings);
        break;

      // Property Inspector sent updated settings
      case "sendToPlugin":
        if (msg.payload?.action === "saveSettings") {
          applySettings(msg.payload.settings);
          setGlobalSettings(globalSettings);
          logMessage("Settings saved");
        }
        if (msg.payload?.action === "testDetection") {
          const proc    = getActiveProcessName();
          const profile = detectProfile(proc);
          send({
            event:   "sendToPropertyInspector",
            context: actionContext,
            action:  "com.lovato.windowsapps-switcher.monitor",
            payload: {
              action: "detectionResult",
              proc,
              profile: profile || "(no match)",
            },
          });
        }
        break;

      case "applicationDidLaunch":
      case "applicationDidTerminate":
        // Reset last profile cache so next poll re-evaluates cleanly
        lastProfile = null;
        break;
    }
  });

  ws.on("close", () => {
    stopPolling();
    // Reconnect after 2s in case StreamDeck restarted
    setTimeout(connect, 2000);
  });

  ws.on("error", () => {
    // Handled by close event
  });
}

connect();
