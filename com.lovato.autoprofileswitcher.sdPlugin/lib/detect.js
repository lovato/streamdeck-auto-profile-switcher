/**
 * Profile detection — title-specific app-map rules, then process-only, then built-in map.
 */
function detectProfile(proc, title = '', appMap = [], builtInMap = {}) {
  const lTitle = title.toLowerCase();
  for (const entry of appMap) {
    if (!entry.titleMatch) continue;
    if (proc.includes(entry.match.toLowerCase()) && lTitle.includes(entry.titleMatch.toLowerCase())) {
      return entry.profile;
    }
  }
  for (const entry of appMap) {
    if (entry.titleMatch) continue;
    if (proc.includes(entry.match.toLowerCase())) return entry.profile;
  }
  if (builtInMap[proc]) return builtInMap[proc];
  return null;
}

module.exports = { detectProfile };
