/**
 * Finds the highest-priority custom rule, or the built-in Smart Profile fallback.
 * Title-specific rules always win over process-only rules.
 */
function findProfileMatch(proc, title = '', appMap = [], builtInMap = {}) {
  const lTitle = title.toLowerCase();
  for (const entry of appMap) {
    if (!entry.titleMatch) continue;
    if (proc.includes(entry.match.toLowerCase()) && lTitle.includes(entry.titleMatch.toLowerCase())) {
      return { type: 'rule', entry };
    }
  }
  for (const entry of appMap) {
    if (entry.titleMatch) continue;
    if (proc.includes(entry.match.toLowerCase())) return { type: 'rule', entry };
  }
  if (builtInMap[proc]) return { type: 'builtIn', profile: builtInMap[proc] };
  return null;
}

/**
 * Resolves a match into a profile target for each connected device.
 *
 * Legacy rules with `profile` broadcast to every device. Per-device assignments
 * override that fallback when both are present, allowing a default plus exceptions.
 * An unmatched device receives null, which tells the caller to release its override.
 */
function resolveProfileAssignments(match, deviceIds) {
  const targets = new Map();
  const assignments = match?.type === 'rule'
    ? new Map((match.entry.assignments || [])
      .filter(a => a?.deviceId && a.profile)
      .map(a => [a.deviceId, a.profile]))
    : new Map();
  const fallback = match?.type === 'builtIn'
    ? match.profile
    : match?.entry?.profile || null;

  for (const deviceId of deviceIds) {
    targets.set(deviceId, assignments.get(deviceId) || fallback);
  }
  return targets;
}

// Retained for callers and saved configurations that only use a single profile.
function detectProfile(proc, title = '', appMap = [], builtInMap = {}) {
  const match = findProfileMatch(proc, title, appMap, builtInMap);
  if (match?.type === 'builtIn') return match.profile;
  return match?.entry?.profile || null;
}

module.exports = { detectProfile, findProfileMatch, resolveProfileAssignments };
