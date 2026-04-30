# Agent / LLM Context — StreamDeck Auto Profile Switcher

This document captures the non-obvious, hard-won implementation details of this
plugin. Read it before touching the switching or profile-ownership logic.

---

## What the plugin does

Switches StreamDeck profiles based on the Windows foreground window. Solves two
gaps in StreamDeck's built-in "Smart Profile" feature:

1. **MSIX/WindowsApps apps** (Teams, WhatsApp, Windows Terminal) run from a
   path that changes on every update, so StreamDeck's process-path matching can
   never detect them. This plugin uses `GetForegroundWindow` → `GetWindowThreadProcessId`
   → `Get-Process` (Win32 P/Invoke via a persistent PowerShell process) to get
   the process name directly.

2. **Window-title rules** — e.g. `windowsterminal + "PowerShell"` → PowerShell
   profile. The built-in has no title-matching at all.

---

## StreamDeck `switchToProfile` — the key constraint

The plugin API's `switchToProfile(name)` only works for profiles where the
`manifest.json` has `InstalledByPluginUUID` set to this plugin's UUID. Without
it, the call silently fails. We call these **plugin-owned profiles**.

`switchToProfile('')` (empty string) releases the plugin's override and reverts
to the profile that was active **immediately before the plugin's most recent
`switchToProfile` call** — think of it as "pop one entry off a stack." It does
NOT re-run the built-in Smart Profile for the current foreground app; the
built-in only fires on actual Windows focus-change events.

### The cascading / "previous profile" problem

If the user visits N plugin-owned profiles in a row without an unmonitored app
in between (e.g. WhatsApp → Chrome → VSCode), StreamDeck's "previous" chain
looks like:

```
VSCode → previous: Chrome
Chrome → previous: WhatsApp
WhatsApp → previous: Default
```

A single `switchToProfile('')` from VSCode reverts only to Chrome, not Default.
**Fix:** track `pluginDepth` (incremented on every plugin-to-plugin switch,
reset to 0 on release) and call `switchToProfile('')` `pluginDepth` times in
rapid succession. Each call peels back one level.

---

## The built-in Smart Profile conflict

Profiles like Chrome and VSCode have `AppIdentifier` in their `manifest.json`
(e.g. `C:\...\chrome.exe`). StreamDeck uses this for its own auto-switching.

When such a profile is also plugin-owned, **two things fight**:

- **T = 0 ms** — Chrome gets focus. StreamDeck's built-in fires (using its
  in-memory `AppIdentifier` state) and switches to Chrome. It records
  `previous = Default`.
- **T ≈ 300 ms** — Our plugin's stability check (2 consecutive polls × 150 ms)
  confirms Chrome is focused and calls `switchToProfile('Chrome')`. By now
  Chrome was already the active profile, so StreamDeck records
  `previous = Chrome`.

Result: `switchToProfile('')` later reverts to Chrome instead of Default.

### Fix: pre-release on first switch

On the **first** plugin switch after an unmonitored state (`lastProfile === null`),
send `switchToProfile('')` first, wait **50 ms**, then send `switchToProfile(X)`.

- The blank release clears whatever the built-in pre-set, resetting the
  "previous" pointer back to Default.
- The 50 ms gap is mandatory. Sending both messages in the same WebSocket flush
  causes StreamDeck to drop the second one — the profile stays on Default.
- This only applies to the null→managed transition. Plugin-to-plugin switches
  (e.g. Terminal→WhatsApp) skip the pre-release to avoid a visible Default
  flash; those cases are handled by the depth counter instead.

---

## AppIdentifier restoration by StreamDeck

StreamDeck **periodically restores** `AppIdentifier` to manifests for profiles
whose associated process is currently running. This undoes our removal.

To prevent StreamDeck from overwriting `InstalledByPluginUUID` when it restores
AppIdentifier, we move `AppIdentifier` to a custom field `PluginSavedAppIdentifier`
when tagging a profile. Without this, having both `AppIdentifier` and
`InstalledByPluginUUID` in the same manifest causes `switchToProfile` to fail
silently (StreamDeck appears to reject plugin switches for profiles it also
considers "Smart Profile" targets).

A 10-second `setInterval` re-runs `syncProfileTags` to keep the migration
applied as StreamDeck restores AppIdentifier in the background.

On **uninstall**, `PluginSavedAppIdentifier` is moved back to `AppIdentifier`
and `InstalledByPluginUUID`/`PreconfiguredName`/`ReadOnly` are removed.

---

## Profile detection — three passes

`detectProfile(proc, title)`:

1. **App-map, title-specific** — user-configured rules that require both a
   process match and a window-title substring. Most specific; checked first.
2. **App-map, process-only** — user-configured rules with no title requirement.
3. **Built-in Smart Profile mirror** — derived from `AppIdentifier` /
   `PluginSavedAppIdentifier` fields in ProfilesV3 manifests. Read at startup
   and on every re-sync. This lets the plugin handle Chrome, VSCode, Zoom, PUBG,
   etc. without duplicating configuration in the UI.

If no pass matches, `detectProfile` returns `null` → plugin releases to Default.

---

## Profile ownership lifecycle

`syncProfileTags(targets)` is called on:
- Plugin startup (`applySettings` after `didReceiveGlobalSettings`)
- Property Inspector appears/disappears
- Every 10 seconds (re-sync timer, to re-apply after StreamDeck restores AppIdentifier)

It tags every profile in `targets` (adds `InstalledByPluginUUID`, moves
`AppIdentifier` to `PluginSavedAppIdentifier`) and untags any previously-owned
profile no longer in `targets` (removes our fields, restores `AppIdentifier`).
The target list is persisted to `%APPDATA%\Elgato\StreamDeck\Data\<uuid>\profiles.json`
so `deploy.ps1` can replicate the same tagging at install time.

### `ensureProfileTagged` — just-in-time re-tagging

`switchToProfile(name)` calls `ensureProfileTagged(name)` before sending the
WebSocket message. This reads the profile's manifest and re-applies the tag
(moves `AppIdentifier` → `PluginSavedAppIdentifier`, adds `InstalledByPluginUUID`)
if StreamDeck has restored the manifest since the last sync. The read+write is
a single file operation, fast enough to not affect perceived latency. The
subsequent `send` happens in the same event-loop tick, so StreamDeck processes
the switch before it can restore the manifest again.

### Persistent AppIdentifier storage (`builtin-app-ids.json`)

Stored in `%APPDATA%\Elgato\StreamDeck\Data\<uuid>\builtin-app-ids.json`.
Written whenever a profile with `AppIdentifier` is first tagged. Survives
StreamDeck manifest restores. `loadBuiltInProfileMap` reads this file as a
fallback: if a profile's manifest has been completely stripped (no `AppIdentifier`,
no `PluginSavedAppIdentifier`), the function uses the saved path to restore
`AppIdentifier` to the manifest and include the profile in `builtInMap`. This
prevents the profile from becoming permanently invisible after multiple
tag/restore cycles.

**Default Profile** (`AppIdentifier = "*"`) is intentionally left **unowned**.
Owning it and calling `switchToProfile('Default Profile')` was tried but found
to make `switchToProfile` calls from built-in-managed profiles (Chrome, VSCode)
silently fail — presumably StreamDeck treats it specially. Using `switchToProfile('')`
with the depth counter achieves the same result reliably.

---

## The persistent PowerShell process

A single `powershell.exe` process is spawned once and kept alive. The plugin
writes `\n` to its stdin to trigger a query; it responds with
`sdOpen|procName|windowTitle` on stdout.

- `sdOpen` — `"1"` if StreamDeck's settings window is visible
  (`MainWindowHandle != Zero`). The plugin pauses switching while the settings
  window is open to prevent profile changes mid-configuration.
- `procName` — from `Get-Process -Id $procId`, lowercased. `$procId` must NOT
  be named `$pid` — that's a reserved PowerShell variable.
- The script is passed via `-EncodedCommand` (Base64 UTF-16LE). Inline
  `-Command "..."` broke on multi-line scripts with special characters.

---

## Stability check

`STABLE_POLLS = 2`, `POLL_INTERVAL_MS = 150 ms`. A process must appear in two
consecutive polls (~300 ms) before the plugin acts. This prevents false switches
during rapid alt-tabbing. Only required for switching **to** a profile; releases
also go through stability (acceptable — brief wrong-profile flash during fast
switching is not noticeable).

---

## Known edge cases / limitations

- **`switchToProfile('')` × N peeling**: works empirically in StreamDeck (each
  call reverts one level of the previous-profile chain) but is undocumented
  behavior. If Elgato changes this, the cascading fix breaks.
- **50 ms pre-release delay**: chosen empirically. Too short and StreamDeck
  drops the subsequent `switchToProfile`; too long and the user sees a Default
  flash before the target profile appears. 50 ms has been unnoticeable in
  practice.
- **AppIdentifier restoration timing**: StreamDeck restores `AppIdentifier`
  for running processes. The 10-second re-sync + pre-release on first switch
  together handle this, but there is a brief window (< 10 s after restoration,
  before re-sync fires) where the built-in could pre-empt our switch. The
  pre-release corrects the "previous" pointer so the release still works.
- **UWP/MSIX process hosting**: some UWP apps report as `ApplicationFrameHost`
  rather than their own process. Use "Test Detection" in the PI to find the
  actual process name for any app.
- **Multiple devices**: the plugin uses `deviceId` from the first
  `deviceDidConnect` event. Profiles are matched by `PreconfiguredName` and
  routed to the correct device by the `device` field in `switchToProfile`.
