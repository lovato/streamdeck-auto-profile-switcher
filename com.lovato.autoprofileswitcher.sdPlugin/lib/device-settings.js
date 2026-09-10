/**
 * Removes assignments for devices absent from Stream Deck's registration
 * catalog. Disabled devices remain in that catalog; forgotten devices do not.
 */
function removeForgottenDeviceAssignments(settings = {}, knownDeviceIds = []) {
  const known = new Set(knownDeviceIds.filter(Boolean));
  const source = Array.isArray(settings.appMap) ? settings.appMap : [];
  let removed = 0;
  const appMap = source
    .map(entry => {
      if (!Array.isArray(entry.assignments)) return entry;
      const assignments = entry.assignments.filter(assignment => {
        const keep = assignment?.deviceId && known.has(assignment.deviceId);
        if (!keep) removed++;
        return keep;
      });
      return { ...entry, assignments };
    })
    .filter(entry => entry.profile || entry.assignments?.length);

  return {
    settings: removed ? { ...settings, appMap } : settings,
    removed,
  };
}

function getDeviceRules(appMap = [], deviceId) {
  return appMap
    .map((entry, entryIndex) => {
      const assignment = (entry.assignments || [])
        .find(item => item?.deviceId === deviceId && item.profile);
      if (!assignment) return null;
      return {
        match: entry.match,
        ...(entry.titleMatch ? { titleMatch: entry.titleMatch } : {}),
        profile: assignment.profile,
        order: Number.isInteger(assignment.order) ? assignment.order : entryIndex,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...rule }) => rule);
}

function replaceDeviceRules(appMap = [], deviceId, rules = []) {
  const retained = appMap
    .map(entry => ({
      ...entry,
      assignments: (entry.assignments || [])
        .filter(assignment => assignment?.deviceId !== deviceId),
    }))
    .filter(entry => entry.profile || entry.assignments.length);

  rules.forEach((rule, order) => {
    if (!rule?.match || !rule.profile) return;
    let entry = retained.find(candidate =>
      candidate.match === rule.match &&
      (candidate.titleMatch || "") === (rule.titleMatch || ""));
    if (!entry) {
      entry = {
        match: rule.match,
        ...(rule.titleMatch ? { titleMatch: rule.titleMatch } : {}),
        assignments: [],
      };
      retained.push(entry);
    }
    entry.assignments.push({ deviceId, profile: rule.profile, order });
  });
  return retained;
}

module.exports = {
  getDeviceRules,
  removeForgottenDeviceAssignments,
  replaceDeviceRules,
};
