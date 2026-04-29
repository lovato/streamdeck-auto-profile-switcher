/**
 * StreamDeck WindowsApps Profile Switcher
 * =========================================
 * Fixes Smart Profile auto-switching for MSIX/WindowsApp packaged apps
 * (Teams, WhatsApp, Windows Terminal) which are invisible to StreamDeck's
 * built-in app detection.
 *
 * How it works:
 *  1. Connects to StreamDeck via WebSocket (standard plugin protocol)
 *  2. Keeps a single persistent PowerShell process that answers
 *     foreground-window queries via stdin/stdout — no per-poll spawn overhead
 *  3. When a configured WindowsApp is detected, sends switchToProfile
 *  4. Tracks last profile to avoid redundant switches
 */

const WebSocket = require("ws");
const { spawn } = require("child_process");
const fs         = require("fs");
const path       = require("path");

// ─── StreamDeck connection args ───────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const PORT         = getArg("-port");
const PLUGIN_UUID  = getArg("-pluginUUID");
const REGISTER_EVT = getArg("-registerEvent");

// ─── Configuration ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = 150;
const STABLE_POLLS       = 2;   // require 2 consecutive detections (~300ms) before switching
const TEST_DELAY_SECONDS = 3;

const DEFAULT_APP_MAP = [
  { match: "ms-teams",        profile: "Teams"    },
  { match: "whatsapp",        profile: "WhatsApp" },
  { match: "windowsterminal", profile: "Terminal" },
];

// ─── State ────────────────────────────────────────────────────────────────────
let ws             = null;
let deviceId       = null;
let actionContext  = null;
let lastProfile    = null;
let appMap         = DEFAULT_APP_MAP;
let pollTimer      = null;
let isPollRunning  = false;
let globalSettings = {};
let stableProc     = '';
let stableCount    = 0;
let isTesting      = false;
let settingsOpen   = false;

// ─── Persistent PowerShell process ───────────────────────────────────────────
// Spawns once and compiles the Win32 P/Invoke helper once. Each query sends a
// newline to stdin; PowerShell outputs the foreground process name and waits
// for the next trigger. Avoids spawning powershell.exe + JIT-compiling C# on
// every 500 ms poll tick.
//
// Passed via -EncodedCommand (Base64 UTF-16LE) so no quoting or escaping is
// needed — the root cause of the previous broken approach.

const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
  using System.Runtime.InteropServices;
  using System.Text;
  public class FgWin32 {
    [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int procId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, StringBuilder sb, int n);
  }
"@
while ($true) {
  $null = [Console]::ReadLine()
  try {
    $fg     = [FgWin32]::GetForegroundWindow()
    $procId = 0
    [FgWin32]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
    $proc = if ($procId -gt 0) { Get-Process -Id $procId -ErrorAction SilentlyContinue } else { $null }
    if (-not $proc) {
      $proc = Get-Process | Where-Object { $_.MainWindowHandle -eq $fg } | Select-Object -First 1
    }
    $sb = New-Object System.Text.StringBuilder 512
    [FgWin32]::GetWindowText($fg, $sb, 512) | Out-Null
    $name  = if ($proc) { $proc.Name } else { "" }
    $title = $sb.ToString()
    [Console]::WriteLine("$name|$title")
  } catch {
    [Console]::WriteLine("|")
  }
  [Console]::Out.Flush()
}
`.trim();

let psProc    = null;
let psOutBuf  = '';
const psQueue = [];  // resolvers waiting for a process-name response

function psEncode(script) {
  const buf = Buffer.alloc(script.length * 2);
  for (let i = 0; i < script.length; i++) buf.writeUInt16LE(script.charCodeAt(i), i * 2);
  return buf.toString('base64');
}

function ensurePS() {
  if (psProc && !psProc.killed) return;

  psProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', psEncode(PS_SCRIPT),
  ], { windowsHide: true });

  psProc.stdout.on('data', (chunk) => {
    psOutBuf += chunk.toString();
    const lines = psOutBuf.split('\n');
    psOutBuf = lines.pop();
    for (const line of lines) {
      const fn = psQueue.shift();
      if (fn) {
        fn(line.trim());
        // If more callers are queued, trigger the next PS read immediately
        if (psQueue.length > 0) psProc.stdin.write('\n');
      }
    }
  });

  psProc.stderr.on('data', (chunk) => logMessage(`PS error: ${chunk.toString().trim()}`));

  psProc.on('exit', () => {
    psProc = null;
    // Drain queue so callers don't hang if PS crashed
    while (psQueue.length > 0) psQueue.shift()('');
  });
}

function getActiveWindowInfo() {
  return new Promise((resolve) => {
    ensurePS();
    const wasEmpty = psQueue.length === 0;
    psQueue.push((line) => {
      const sep   = line.indexOf('|');
      const proc  = (sep >= 0 ? line.slice(0, sep) : line).toLowerCase().trim();
      const title = (sep >= 0 ? line.slice(sep + 1) : '').trim();
      resolve({ proc, title });
    });
    if (wasEmpty) psProc.stdin.write('\n');
  });
}

function getActiveProcessName() {
  return getActiveWindowInfo().then(({ proc }) => proc);
}

// ─── ProfilesV3 helpers ────────────────────────────────────────────────────────────────────────────
const V3_DIR    = path.join(process.env.APPDATA, 'Elgato', 'StreamDeck', 'ProfilesV3');
const PLUGIN_ID = 'com.lovato.windowsapps-switcher';

function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(V3_DIR, dir, 'manifest.json'), 'utf8')
      .replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch { return null; }
}

function getProfileNames() {
  try {
    const names = fs.readdirSync(V3_DIR)
      .filter(d => d.endsWith('.sdProfile'))
      .map(d => readManifest(d)?.Name || null)
      .filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

function tagNewProfiles() {
  try {
    for (const dir of fs.readdirSync(V3_DIR).filter(d => d.endsWith('.sdProfile'))) {
      const mPath = path.join(V3_DIR, dir, 'manifest.json');
      const m = readManifest(dir);
      if (!m) continue;
      if (m.InstalledByPluginUUID && m.InstalledByPluginUUID !== PLUGIN_ID) continue;
      if (m.InstalledByPluginUUID === PLUGIN_ID && m.PreconfiguredName && m.ReadOnly === false) continue;
      m.InstalledByPluginUUID = PLUGIN_ID;
      m.PreconfiguredName     = m.Name;
      m.ReadOnly              = false;
      fs.writeFileSync(mPath, JSON.stringify(m), { encoding: 'utf8' });
    }
  } catch { /* non-fatal */ }
}

// ─── Profile detection ────────────────────────────────────────────────────────
// Two-pass: title-specific entries win over process-only entries.
function detectProfile(proc, title = '') {
  const lTitle = title.toLowerCase();
  // Pass 1 — entries that also require a title match (more specific)
  for (const entry of appMap) {
    if (!entry.titleMatch) continue;
    if (proc.includes(entry.match.toLowerCase()) && lTitle.includes(entry.titleMatch.toLowerCase())) {
      return entry.profile;
    }
  }
  // Pass 2 — entries with no title requirement (generic fallback)
  for (const entry of appMap) {
    if (entry.titleMatch) continue;
    if (proc.includes(entry.match.toLowerCase())) return entry.profile;
  }
  return null;
}

// ─── StreamDeck WebSocket send helpers ───────────────────────────────────────
function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function switchToProfile(profileName) {
  if (!deviceId) return;
  send({ event: "switchToProfile", context: PLUGIN_UUID, device: deviceId, payload: { profile: profileName } });
}

function setGlobalSettings(settings) {
  send({ event: "setGlobalSettings", context: PLUGIN_UUID, payload: settings });
}

function getGlobalSettings() {
  send({ event: "getGlobalSettings", context: PLUGIN_UUID });
}

function logMessage(msg) {
  send({ event: "logMessage", context: actionContext || PLUGIN_UUID, payload: { message: `[WindowsApps Switcher] ${msg}` } });
}

function sendToPI(payload) {
  send({
    event:   "sendToPropertyInspector",
    context: actionContext,
    action:  "com.lovato.windowsapps-switcher.monitor",
    payload,
  });
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function pollOnce() {
  if (isPollRunning || isTesting || settingsOpen) return;
  isPollRunning = true;
  try {
    const { proc, title } = await getActiveWindowInfo();

    if (proc === stableProc) {
      stableCount = Math.min(stableCount + 1, STABLE_POLLS);
    } else {
      stableProc  = proc;
      stableCount = 1;
    }
    if (stableCount < STABLE_POLLS) return;

    const profile = detectProfile(proc, title);
    if (profile !== lastProfile) {
      lastProfile = profile;
      if (profile) {
        logMessage(`Detected "${proc}" → switching to profile "${profile}"`);
        switchToProfile(profile);
      } else {
        switchToProfile('');  // release back to StreamDeck's built-in Smart Profile
      }
    }
  } finally {
    isPollRunning = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Apply settings from global store ────────────────────────────────────────
function applySettings(settings) {
  globalSettings = settings || {};
  if (Array.isArray(globalSettings.appMap) && globalSettings.appMap.length > 0) {
    appMap = globalSettings.appMap;
    logMessage(`Loaded custom app map with ${appMap.length} entries`);
  } else {
    appMap = DEFAULT_APP_MAP;
  }
}

// ─── Test detection with countdown ───────────────────────────────────────────
// Gives the user time to focus the target app before capturing.
function runTestDetection() {
  isTesting     = true;
  let remaining = TEST_DELAY_SECONDS;
  sendToPI({ action: "detectionCountdown", seconds: remaining });

  const tick = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      sendToPI({ action: "detectionCountdown", seconds: remaining });
    } else {
      clearInterval(tick);
      getActiveWindowInfo().then(({ proc, title }) => {
        isTesting = false;  // countdown done; settingsOpen now prevents any switching
        const profile = detectProfile(proc, title);
        const result  = { proc, title, profile: profile || "(no match)" };
        globalSettings.lastDetection = result;
        setGlobalSettings(globalSettings);
        sendToPI({ action: "detectionResult", ...result });
      });
    }
  }, 1000);
}

// ─── WebSocket connection ─────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}`);

  ws.on("open", () => {
    tagNewProfiles();
    send({ event: REGISTER_EVT, uuid: PLUGIN_UUID });
    getGlobalSettings();
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case "deviceDidConnect":
        if (!deviceId) { deviceId = msg.device; logMessage(`Device connected: ${deviceId}`); startPolling(); }
        break;

      case "deviceDidDisconnect":
        if (msg.device === deviceId) { deviceId = null; stopPolling(); }
        break;

      case "willAppear":
        actionContext = msg.context;
        if (!deviceId) deviceId = msg.device;
        if (!pollTimer) startPolling();
        break;

      case "willDisappear":
        break;

      case "propertyInspectorDidAppear":
        settingsOpen = true;
        tagNewProfiles();
        sendToPI({ action: "profilesList", profiles: getProfileNames() });
        break;

      case "propertyInspectorDidDisappear":
        settingsOpen = false;
        stableProc   = '';  // reset stability so the first poll after closing re-evaluates cleanly
        stableCount  = 0;
        break;

      case "didReceiveGlobalSettings":
        applySettings(msg.payload?.settings);
        break;

      case "sendToPlugin":
        if (msg.payload?.action === "saveSettings") {
          applySettings(msg.payload.settings);
          setGlobalSettings(globalSettings);
          logMessage("Settings saved");
        }
        if (msg.payload?.action === "testDetection") {
          runTestDetection();
        }
        if (msg.payload?.action === "getProfiles") {
          sendToPI({ action: "profilesList", profiles: getProfileNames() });
        }
        break;

      case "applicationDidLaunch":
      case "applicationDidTerminate":
        lastProfile = null;
        break;
    }
  });

  ws.on("close", () => { stopPolling(); setTimeout(connect, 2000); });
  ws.on("error", () => {});
}

connect();
