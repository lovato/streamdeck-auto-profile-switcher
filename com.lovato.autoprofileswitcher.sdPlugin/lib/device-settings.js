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

module.exports = { removeForgottenDeviceAssignments };
