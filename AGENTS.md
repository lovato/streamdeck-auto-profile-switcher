# Agent / LLM Context — StreamDeck Auto Profile Switcher

This document explains **why** the code is structured the way it is. Every
architectural decision here was forced by a StreamDeck constraint or a Windows
behavior that doesn't match intuition. Read it before changing the switching
logic — you will almost certainly break something that looked fine.

---

## What the plugin does

Switches StreamDeck profiles based on the Windows foreground window. Solves two
gaps in StreamDeck's built-in "Smart Profile" feature:

1. **MSIX/WindowsApps apps** (Teams, WhatsApp, Windows Terminal) run from a
   path that changes on every update, so StreamDeck's process-path matching can
   never detect them. We use `GetForegroundWindow` → `GetWindowThreadProcessId`
   → `Get-Process` via a persistent PowerShell process.

2. **Window-title rules** — e.g. `windowsterminal + "PowerShell"` → PowerShell
   profile. The built-in has no title-matching.

---

## Why we must "own" profiles to switch them

StreamDeck's `switchToProfile(name)` is a plugin API with a hidden requirement:
it **silently fails** unless the target profile's `manifest.json` contains
`InstalledByPluginUUID` matching the caller's UUID. This is not documented
anywhere. Without it, the WebSocket message is accepted and nothing happens.

We call these **plugin-owned profiles**. The plugin must tag every profile it
wants to switch to.

## Why `switchToProfile('')` is our release mechanism

`switchToProfile('')` (empty string) tells StreamDeck to "pop" the plugin's
override and revert to whatever profile was active immediately before the
plugin's **most recent** `switchToProfile` call. It's a stack — each call
pushes, `''` pops one level.

It does **NOT** re-run the built-in Smart Profile. The built-in only fires on
actual Windows focus-change events (WM_ACTIVATE), not on programmatic profile
switches.

## Why we track `pluginDepth` and call `switchToProfile('')` N times

Because `switchToProfile('')` pops only one level. If the user alt-tabs through
N plugin-owned profiles without visiting an unmonitored app:

```
Terminal → WhatsApp → Chrome → VSCode
```

StreamDeck's stack looks like:
```
VSCode → previous: Chrome
Chrome → previous: WhatsApp
WhatsApp → previous: Terminal
Terminal → previous: Default
```

A single `switchToProfile('')` from VSCode reverts to Chrome, not Default.
**Fix:** track `pluginDepth` (incremented on every plugin-managed switch, reset
to 0 on release) and call `switchToProfile('')` that many times in rapid
succession. Each call peels back one level.

This is undocumented behavior. If Elgato changes it, the cascading fix breaks.

## Why the pre-release + 50 ms delay on first switch

When a profile with `AppIdentifier` (e.g. Chrome) is also plugin-owned, the
built-in Smart Profile fires **before** our plugin detects it:

```
T = 0 ms      — Chrome gets focus. StreamDeck's built-in fires (uses its
                in-memory AppIdentifier state) and switches to Chrome.
                It records: previous = Default.

T ≈ 300 ms    — Our plugin confirms Chrome and calls switchToProfile('Chrome').
                Chrome was already active, so StreamDeck records:
                previous = Chrome.
```

Now `switchToProfile('')` from Chrome reverts to Chrome, not Default.

**Fix:** on the first plugin switch after an unmonitored state (`lastProfile === null`),
send `switchToProfile('')` first, wait 50 ms, then send `switchToProfile(X)`.

- The blank release clears whatever the built-in pre-set, resetting "previous"
  back to Default.
- The 50 ms gap is **mandatory**. Sending both in the same WebSocket flush
  causes StreamDeck to drop the second message — the profile stays on Default.
- Only applies to null→managed transitions. Plugin-to-plugin switches skip the
  pre-release to avoid a visible Default flash (depth counter handles those).

## Why `AppIdentifier` must be removed (moved to `PluginSavedAppIdentifier`)

Having both `AppIdentifier` and `InstalledByPluginUUID` in the same manifest
causes `switchToProfile` to **fail silently**. StreamDeck appears to reject
plugin switches for profiles it also considers "Smart Profile" targets.

But we can't just delete `AppIdentifier` — StreamDeck **periodically restores**
it to manifests for profiles whose associated process is running. And on
uninstall, we need to put it back.

**Fix:** rename it to `PluginSavedAppIdentifier` (a custom field StreamDeck
ignores). On tag: move `AppIdentifier` → `PluginSavedAppIdentifier`, add
`InstalledByPluginUUID`. On untag: reverse. On re-sync: if `AppIdentifier`
reappeared, move it again.

## Why `ensureProfileTagged` must check `AppIdentifier` even when already owned

StreamDeck restores `AppIdentifier` to running-app manifests at unpredictable
intervals. If it does this to a profile we already own, the manifest ends up
with **both** fields — and `switchToProfile` fails silently.

The old code returned early when `InstalledByPluginUUID === PLUGIN_ID`, missing
the case where `AppIdentifier` had been restored. **Fix:** the function now
checks if `AppIdentifier` is present even when we own the profile, and re-applies
the migration before sending the switch.

## Why the 10-second re-sync timer

`syncProfileTags(allTargets())` runs every 10 seconds to re-apply the
`AppIdentifier` → `PluginSavedAppIdentifier` migration. This handles the window
between StreamDeck restoring `AppIdentifier` and our next poll. The pre-release
on first switch is the primary defense; the re-sync is the backup.

## Why `ensureProfileTagged` (just-in-time re-tagging)

`syncProfileTags` runs periodically, but the 10-second window means a manifest
could be "dirty" when we try to switch. `switchToProfile(name)` calls
`ensureProfileTagged(name)` right before sending the WebSocket message.

It reads the manifest, fixes it if `AppIdentifier` is present, writes it back,
then sends the switch — all in the same event-loop tick. Fast enough to not
affect perceived latency, and StreamDeck can't restore the manifest again before
the switch fires.

## Why we don't own the Default Profile

The Default Profile has `AppIdentifier = "*"`. We tried owning it and calling
`switchToProfile('Default Profile')` but found it made `switchToProfile` calls
from built-in-managed profiles (Chrome, VSCode) **silently fail** — StreamDeck
treats it specially.

Leaving it unowned and using `switchToProfile('')` with the depth counter
achieves the same result reliably.

## Why the persistent PowerShell process

Spawning `powershell.exe` + JIT-compiling the C# P/Invoke helper on every
150 ms poll tick is too slow. We spawn one process and keep it alive. Each
query is a single `\n` to stdin; the process responds on stdout.

- Passed via `-EncodedCommand` (Base64 UTF-16LE) because inline `-Command "..."`
  broke on multi-line scripts with special characters.
- `$procId` must NOT be named `$pid` — that's a reserved PowerShell variable.
- If the process crashes, the queue drains so callers don't hang.

## Why stability check (2 polls × 150 ms = ~300 ms)

Prevents false switches during rapid alt-tabbing. A process must appear in two
consecutive polls before the plugin acts. Only required for switching **to** a
profile, but releases also go through stability — the brief wrong-profile flash
during fast switching is not noticeable.

## Why profile name fallback (`PROFILE_NAME_TO_PROCESS`)

Many users never configure their profiles as StreamDeck Smart Profiles. Those
profiles have **no** `AppIdentifier` in their manifest. Without `AppIdentifier`,
`loadBuiltInProfileMap()` can't detect them, and the plugin can't handle
transitions to them.

**Fix:** `PROFILE_NAME_TO_PROCESS` maps common profile names to process names
(e.g. "VSCode" → "code", "Chrome" → "chrome"). Used as a fallback when the
manifest has no `AppIdentifier` and no `PluginSavedAppIdentifier`.

Covers Chrome, VSCode, Firefox, Edge, Discord, Steam, and many games/dev tools.
New entries are easy to add — just lowercase profile name → lowercase process
name.

## Why `detectProfile` has 4 passes (in this order)

1. **App-map, title-specific** — most specific (process + title substring)
2. **App-map, process-only** — user-configured generic rules
3. **Built-in Smart Profile mirror** — from `AppIdentifier` / `PluginSavedAppIdentifier`
4. **Profile name fallback** — `PROFILE_NAME_TO_PROCESS`

Title-specific wins over process-only because it's more specific. This lets
users define `windowsterminal + "PowerShell"` → PowerShell, with
`windowsterminal` → Terminal as a catch-all fallback.

## Why the target list is persisted (`profiles.json`)

`syncProfileTags` writes its target list to
`%APPDATA%\Elgato\StreamDeck\Data\<uuid>\profiles.json`. `deploy.ps1` reads this
at install time to replicate the same tagging without starting the plugin. This
keeps deploy and runtime in sync.

## Why persistent AppIdentifier storage (`builtin-app-ids.json`)

Written whenever a profile with `AppIdentifier` is first tagged. Survives
StreamDeck manifest restores. Used as a recovery fallback: if a profile's
manifest has been completely stripped (no `AppIdentifier`, no
`PluginSavedAppIdentifier`), `loadBuiltInProfileMap()` uses the saved path to
restore `AppIdentifier` so it can be properly re-tagged. Prevents the profile
from becoming permanently invisible after multiple tag/restore cycles.

## Why the build/bundle step is required

StreamDeck's `streamdeck pack` includes ALL `node_modules/` (4995 files, 21MB+)
which causes the plugin to fail installation silently. The fix: use `ncc` to bundle
dependencies into a single file.

**Build process:**
```bash
npx @vercel/ncc build app.js --out build/
```

This creates `build/index.js` (157KB) with all dependencies bundled. The `plugin.html`
file loads this bundled file:
```html
<script src="build/index.js"></script>
```

**Manifest must use:** `"CodePath": "plugin.html"` (not `app.js` directly).

**Packaging:**
```bash
npx streamdeck pack . -o ../dist/ --force --no-update-check
```

Only the bundled `build/` directory should be in the package, not raw `node_modules/`.

## Why `CodePath` points to `build/index.js`

StreamDeck runs Node.js plugins by executing the file at `CodePath` directly.
The manifest uses `"CodePath": "build/index.js"` — the ncc-bundled output that
includes `ws` and all other dependencies in a single self-contained file.

`plugin.html` is unused and was a dead end from a previous attempt. Do not
set `CodePath` to an HTML file for a Node.js plugin — StreamDeck would not
know how to run it.

## Known edge cases / limitations

- **`switchToProfile('')` × N peeling**: undocumented behavior. If Elgato
  changes it, the cascading fix breaks.
- **50 ms pre-release delay**: empirical. Too short → StreamDeck drops the
  second message. Too long → user sees Default flash. 50 ms is unnoticeable.
- **AppIdentifier restoration window**: brief gap (< 10 s after restoration,
  before re-sync) where the built-in could pre-empt our switch. The pre-release
  corrects the "previous" pointer.
- **UWP/MSIX process hosting**: some UWP apps report as `ApplicationFrameHost`.
  Use "Test Detection" in the PI to find the actual process name.
- **Multiple devices**: the plugin tracks every connected `deviceId` and keeps
  the profile stack state independently per device. Rules may broadcast a
  legacy `profile` to all devices or use `assignments` to select a different
  profile for each device. Built-in Smart Profile mirrors broadcast to all
  connected devices. ProfilesV3 manifests are still indexed globally by profile
  name, so per-device targets should use distinct profile names.
- **Bundled build required**: raw `node_modules/` (21MB+) causes silent install
  failure. Must use `ncc` to create `build/index.js` (157KB bundled).
