/**
 * StreamDeck Auto Profile Switcher
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
const { detectProfile: detectProfileFromMaps } = require("./lib/detect");

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

const DEFAULT_APP_MAP = [];

// ─── State ────────────────────────────────────────────────────────────────────
let ws             = null;
let deviceId       = null;
let actionContext  = null;
let lastProfile    = null;
let pluginDepth    = 0;   // consecutive plugin-managed profile switches since last unmonitored app
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
    $sdWin = Get-Process -Name 'StreamDeck' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } | Select-Object -First 1
    $sdOpen = if ($sdWin) { "1" } else { "0" }
    [Console]::WriteLine("$sdOpen|$name|$title")
  } catch {
    [Console]::WriteLine("0||")
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
      const firstPipe = line.indexOf('|');
      const sdOpen    = firstPipe >= 0 && line.slice(0, firstPipe) === '1';
      const rest      = firstPipe >= 0 ? line.slice(firstPipe + 1) : line;
      const sep       = rest.indexOf('|');
      const proc      = (sep >= 0 ? rest.slice(0, sep) : rest).toLowerCase().trim();
      const title     = (sep >= 0 ? rest.slice(sep + 1) : '').trim();
      resolve({ proc, title, sdOpen });
    });
    if (wasEmpty) psProc.stdin.write('\n');
  });
}

// ─── ProfilesV3 helpers ────────────────────────────────────────────────────────────────────────────
const V3_DIR    = path.join(process.env.APPDATA, 'Elgato', 'StreamDeck', 'ProfilesV3');
const PLUGIN_ID = 'com.lovato.autoprofileswitcher';

function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(V3_DIR, dir, 'manifest.json'), 'utf8')
      .replace(/^\uFEFF/, '');
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

// ─── Built-in Smart Profile mirror ───────────────────────────────────────────
// Reads AppIdentifier from ProfilesV3 manifests so the plugin can handle
// transitions from plugin-managed profiles (WhatsApp) to built-in-managed
// profiles (Chrome, Zoom) without losing the Default fallback.
//
// AppIdentifier="*" (the Default Profile catch-all) is intentionally excluded:
// we leave Default Profile unowned so switchToProfile('') always has a
// non-plugin fallback to revert to.
//
// StreamDeck periodically restores AppIdentifier in manifests for running apps,
// so syncProfileTags is called on a timer to keep the migration applied.
//
// For profiles without AppIdentifier (user never configured Smart Profile),
// we also try to infer the process name from the profile name using common
// patterns. This lets the plugin handle Chrome, VSCode, etc. out of the box.
let builtInMap = {};  // { processName → profileName }

function loadBuiltInProfileMap() {
  loadSavedBuiltInIds();
  const map = {};
  const seenNames = new Set();
  try {
    for (const dir of fs.readdirSync(V3_DIR).filter(d => d.endsWith('.sdProfile'))) {
      const m = readManifest(dir);
      if (!m) continue;
      if (m.InstalledByPluginUUID && m.InstalledByPluginUUID !== PLUGIN_ID) continue;
      // AppIdentifier = untagged; PluginSavedAppIdentifier = already owned by us
      let appId = m.AppIdentifier || m.PluginSavedAppIdentifier;
      if (!appId || appId === '*') {
        // TODO: auto-detect by profile name — disabled until we decide how to surface it to users.
        // See lib/profile-name-fallback.js. All switching must be explicit (AppIdentifier or manual patch).
        // const { PROFILE_NAME_TO_PROCESS } = require('./lib/profile-name-fallback');
        // const lowerName = m.Name.toLowerCase();
        // if (PROFILE_NAME_TO_PROCESS[lowerName]) {
        //   map[PROFILE_NAME_TO_PROCESS[lowerName]] = m.Name;
        // }
        seenNames.add(m.Name);
        continue;
      }
      seenNames.add(m.Name);
      const procName = appId.split(/[/\\]/).pop().replace(/\.exe$/i, '').toLowerCase();
      if (procName && m.Name) map[procName] = m.Name;
    }
  } catch { /* non-fatal */ }
  // Recover profiles whose manifests were completely stripped by StreamDeck.
  // If savedBuiltInIds has a path for a profile we didn't find via manifests,
  // restore the AppIdentifier field so it can be properly tagged next sync.
  for (const [name, appId] of Object.entries(savedBuiltInIds)) {
    if (seenNames.has(name)) continue;  // already found in manifests
    const procName = appId.split(/[/\\]/).pop().replace(/\.exe$/i, '').toLowerCase();
    if (!procName) continue;
    map[procName] = name;
    // Restore AppIdentifier to the manifest so syncProfileTags can retag it
    try {
      for (const dir of fs.readdirSync(V3_DIR).filter(d => d.endsWith('.sdProfile'))) {
        const m = readManifest(dir);
        if (!m || m.Name !== name) continue;
        if (!m.AppIdentifier && !m.PluginSavedAppIdentifier) {
          m.AppIdentifier = appId;
          fs.writeFileSync(path.join(V3_DIR, dir, 'manifest.json'), JSON.stringify(m));
        }
        break;
      }
    } catch { /* non-fatal */ }
  }
  return map;
}

function allTargets() {
  return [...new Set([
    ...appMap.map(e => e.profile).filter(Boolean),
    ...Object.values(builtInMap),
    ...manualPatches,
  ])];
}

// Tags every profile the plugin needs to switch to (app-map targets + built-in
// Smart Profile targets derived from AppIdentifier). Untags any we previously
// owned but no longer need. Persists the list to profiles.json for deploy.ps1.
const DATA_DIR          = path.join(process.env.APPDATA, 'Elgato', 'StreamDeck', 'Data', PLUGIN_ID);
const TAGS_FILE         = path.join(DATA_DIR, 'profiles.json');
const BUILTIN_ID_FILE   = path.join(DATA_DIR, 'builtin-app-ids.json');
const MANUAL_PATCH_FILE = path.join(DATA_DIR, 'manual-patches.json');

// Profiles the user explicitly patched via the PI. Persisted so the resync
// timer never untags them between restarts.
let manualPatches = new Set();

function loadManualPatches() {
  try { manualPatches = new Set(JSON.parse(fs.readFileSync(MANUAL_PATCH_FILE, 'utf8'))); } catch { manualPatches = new Set(); }
}

function saveManualPatches() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MANUAL_PATCH_FILE, JSON.stringify([...manualPatches]), { encoding: 'utf8' });
  } catch { /* non-fatal */ }
}

// Persistent map of profileName → AppIdentifier path, written whenever we tag
// a profile. Survives StreamDeck manifest restores and lets us recover profiles
// that have been completely stripped of their AppIdentifier.
let savedBuiltInIds = {};

function loadSavedBuiltInIds() {
  try { savedBuiltInIds = JSON.parse(fs.readFileSync(BUILTIN_ID_FILE, 'utf8')); } catch { savedBuiltInIds = {}; }
}

function saveBuiltInId(name, appId) {
  savedBuiltInIds[name] = appId;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BUILTIN_ID_FILE, JSON.stringify(savedBuiltInIds), { encoding: 'utf8' });
  } catch { /* non-fatal */ }
}

function removeBuiltInId(name) {
  if (!(name in savedBuiltInIds)) return;
  delete savedBuiltInIds[name];
  try { fs.writeFileSync(BUILTIN_ID_FILE, JSON.stringify(savedBuiltInIds), { encoding: 'utf8' }); } catch { /* non-fatal */ }
}

function syncProfileTags(targets) {
  const targetSet = new Set(targets);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TAGS_FILE, JSON.stringify([...targetSet]), { encoding: 'utf8' });
  } catch { /* non-fatal */ }
  try {
    for (const dir of fs.readdirSync(V3_DIR).filter(d => d.endsWith('.sdProfile'))) {
      const mPath = path.join(V3_DIR, dir, 'manifest.json');
      const m = readManifest(dir);
      if (!m) continue;
      const isOurs    = m.InstalledByPluginUUID === PLUGIN_ID;
      const shouldTag = targetSet.has(m.Name);
      const PLUGIN_KEYS = ['InstalledByPluginUUID', 'PreconfiguredName', 'ReadOnly', 'PluginSavedAppIdentifier'];
      if (shouldTag && !isOurs) {
        if (m.InstalledByPluginUUID) continue;  // owned by another plugin
        if (m.AppIdentifier) {
          saveBuiltInId(m.Name, m.AppIdentifier);
          m.PluginSavedAppIdentifier = m.AppIdentifier;
          delete m.AppIdentifier;
        }
        m.InstalledByPluginUUID = PLUGIN_ID;
        m.PreconfiguredName     = m.Name;
        m.ReadOnly              = false;
        fs.writeFileSync(mPath, JSON.stringify(m), { encoding: 'utf8' });
      } else if (isOurs && shouldTag && m.AppIdentifier) {
        // Migration: already tagged but AppIdentifier wasn't moved yet
        saveBuiltInId(m.Name, m.AppIdentifier);
        m.PluginSavedAppIdentifier = m.AppIdentifier;
        delete m.AppIdentifier;
        fs.writeFileSync(mPath, JSON.stringify(m), { encoding: 'utf8' });
      } else if (isOurs && !shouldTag) {
        removeBuiltInId(m.Name);
        const clean = Object.fromEntries(
          Object.entries(m).filter(([k]) => !PLUGIN_KEYS.includes(k))
        );
        if (m.PluginSavedAppIdentifier) clean.AppIdentifier = m.PluginSavedAppIdentifier;
        fs.writeFileSync(mPath, JSON.stringify(clean), { encoding: 'utf8' });
      }
    }
  } catch { /* non-fatal */ }
}

// Returns all profiles with their ownership/tagging status so the PI can show
// which profiles will work with switchToProfile and which need patching.
function getProfilesStatus() {
  const byName = new Map(); // name → best status (deduplicate)
  const STATUS_PRIORITY = { ready: 0, conflict: 1, smart: 2, plain: 3, other: 4, default: 5 };
  try {
    for (const dir of fs.readdirSync(V3_DIR).filter(d => d.endsWith('.sdProfile'))) {
      const m = readManifest(dir);
      if (!m?.Name) continue;
      let status;
      if (m.InstalledByPluginUUID === PLUGIN_ID) {
        status = m.AppIdentifier ? 'conflict' : 'ready';
      } else if (m.InstalledByPluginUUID) {
        status = 'other';
      } else if (m.AppIdentifier === '*') {
        status = 'default';
      } else if (m.AppIdentifier) {
        status = 'smart';
      } else {
        status = 'plain';
      }
      const existing = byName.get(m.Name);
      if (!existing || (STATUS_PRIORITY[status] ?? 99) < (STATUS_PRIORITY[existing.status] ?? 99)) {
        byName.set(m.Name, { name: m.Name, status });
      }
    }
  } catch { /* non-fatal */ }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Tags specific profiles by name, regardless of whether they're in allTargets().
// Used from the PI "Patch" buttons to mark profiles as plugin-owned so that
// switchToProfile will work for them.
function patchProfiles(names, force = false) {
  const nameSet = new Set(names);
  try {
    for (const dir of fs.readdirSync(V3_DIR).filter(d => d.endsWith('.sdProfile'))) {
      const mPath = path.join(V3_DIR, dir, 'manifest.json');
      const m = readManifest(dir);
      if (!m?.Name || !nameSet.has(m.Name)) continue;
      if (m.InstalledByPluginUUID && m.InstalledByPluginUUID !== PLUGIN_ID && !force) continue;
      if (m.AppIdentifier && m.AppIdentifier !== '*') {
        saveBuiltInId(m.Name, m.AppIdentifier);
        m.PluginSavedAppIdentifier = m.AppIdentifier;
        delete m.AppIdentifier;
      }
      m.InstalledByPluginUUID = PLUGIN_ID;
      m.PreconfiguredName     = m.Name;
      m.ReadOnly              = false;
      try { fs.writeFileSync(mPath, JSON.stringify(m)); } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
  for (const n of names) manualPatches.add(n);
  saveManualPatches();
  builtInMap = loadBuiltInProfileMap();
  buildProfileDirMap();
  syncProfileTags(allTargets());
}

// ─── Profile detection ────────────────────────────────────────────────────────
function detectProfile(proc, title = '') {
  return detectProfileFromMaps(proc, title, appMap, builtInMap);
}

// ─── Profile directory index ──────────────────────────────────────────────────
// Maps profile name → sdProfile directory name. Rebuilt whenever we reload
// the built-in map, so lookups in ensureProfileTagged are a single file read.
let profileDirMap = {};

function buildProfileDirMap() {
  profileDirMap = {};
  try {
    for (const dir of fs.readdirSync(V3_DIR).filter(d => d.endsWith('.sdProfile'))) {
      const m = readManifest(dir);
      if (m?.Name) profileDirMap[m.Name] = dir;
    }
  } catch { /* non-fatal */ }
}

// Re-tags a single profile right before switchToProfile is called. StreamDeck
// periodically restores AppIdentifier to manifests for running apps, which can
// break switchToProfile when both AppIdentifier and InstalledByPluginUUID are
// present. We must re-apply the migration even if we already own the profile.
function ensureProfileTagged(name) {
  const dir = profileDirMap[name];
  if (!dir) return;
  const m = readManifest(dir);
  if (!m) return;
  if (m.InstalledByPluginUUID && m.InstalledByPluginUUID !== PLUGIN_ID) return; // owned by another plugin
  let dirty = false;
  if (m.AppIdentifier) {
    m.PluginSavedAppIdentifier = m.AppIdentifier;
    delete m.AppIdentifier;
    dirty = true;
  }
  if (m.InstalledByPluginUUID !== PLUGIN_ID) {
    m.InstalledByPluginUUID = PLUGIN_ID;
    m.PreconfiguredName     = m.Name;
    m.ReadOnly              = false;
    dirty = true;
  }
  if (dirty) {
    try { fs.writeFileSync(path.join(V3_DIR, dir, 'manifest.json'), JSON.stringify(m)); } catch { /* non-fatal */ }
  }
}

// ─── StreamDeck WebSocket send helpers ───────────────────────────────────────
function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function switchToProfile(profileName) {
  if (!deviceId) return;
  if (profileName) ensureProfileTagged(profileName);
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
    action:  "com.lovato.autoprofileswitcher.monitor",
    payload,
  });
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function pollOnce() {
  if (isPollRunning || isTesting || settingsOpen) return;
  isPollRunning = true;
  try {
    const { proc, title, sdOpen } = await getActiveWindowInfo();

    if (sdOpen) {
      stableProc  = '';
      stableCount = 0;
      return;
    }

    if (proc === stableProc) {
      stableCount = Math.min(stableCount + 1, STABLE_POLLS);
    } else {
      stableProc  = proc;
      stableCount = 1;
    }
    if (stableCount < STABLE_POLLS) return;

    const profile = detectProfile(proc, title);
    if (profile !== lastProfile) {
      if (profile) {
        const isFirst = (lastProfile === null);
        pluginDepth = isFirst ? 1 : pluginDepth + 1;
        lastProfile = profile;
        if (isFirst) {
          switchToProfile('');
          await new Promise(r => setTimeout(r, 50));
        }
        logMessage(`Detected "${proc}" → switching to profile "${profile}"`);
        switchToProfile(profile);
      } else {
        // Call switchToProfile('') once per depth level so StreamDeck peels
        // back through any stacked plugin profiles and lands on Default.
        const releases = Math.max(pluginDepth, 1);
        pluginDepth = 0;
        lastProfile = null;
        for (let i = 0; i < releases; i++) switchToProfile('');
      }
    }
  } finally {
    isPollRunning = false;
  }
}

let resyncTimer = null;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  // StreamDeck restores AppIdentifier in manifests for running apps; re-sync
  // periodically to keep the AppIdentifier→PluginSavedAppIdentifier migration applied.
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = setInterval(() => {
    builtInMap = loadBuiltInProfileMap();
    buildProfileDirMap();
    syncProfileTags(allTargets());
  }, 10000);
}

function stopPolling() {
  if (pollTimer)  { clearInterval(pollTimer);  pollTimer  = null; }
  if (resyncTimer){ clearInterval(resyncTimer); resyncTimer = null; }
}

// ─── Apply settings from global store ────────────────────────────────────────
function applySettings(settings) {
  globalSettings = settings || {};
  appMap = (Array.isArray(globalSettings.appMap) && globalSettings.appMap.length > 0)
    ? globalSettings.appMap
    : DEFAULT_APP_MAP;
  builtInMap = loadBuiltInProfileMap();
  buildProfileDirMap();
  if (appMap.length > 0) logMessage(`Loaded app map: ${appMap.length} custom rules, ${Object.keys(builtInMap).length} built-in Smart Profile apps`);
  syncProfileTags(allTargets());
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
    loadManualPatches();
    builtInMap = loadBuiltInProfileMap();
    buildProfileDirMap();
    // Don't syncProfileTags here — appMap is empty until didReceiveGlobalSettings.
    // applySettings() will do the full sync once settings are loaded.
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
        builtInMap = loadBuiltInProfileMap();
        buildProfileDirMap();
        syncProfileTags(allTargets());
        sendToPI({ action: "profilesList", profiles: getProfileNames() });
        sendToPI({ action: "profilesStatus", profiles: getProfilesStatus() });
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
        if (msg.payload?.action === "getProfilesStatus") {
          sendToPI({ action: "profilesStatus", profiles: getProfilesStatus() });
        }
        if (msg.payload?.action === "patchProfiles") {
          patchProfiles(msg.payload.names || [], msg.payload.force || false);
          sendToPI({ action: "profilesStatus", profiles: getProfilesStatus() });
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
