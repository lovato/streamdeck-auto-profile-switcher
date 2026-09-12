/**
 * Computes one device's profile-stack transition without any Stream Deck I/O.
 * The caller sends pre-release, switch, or release messages in the returned order.
 */
function transitionDeviceState(current = {}, profile) {
  const previous = current.lastProfile || null;
  const depth = current.pluginDepth || 0;

  if (profile === previous) return null;

  if (profile) {
    const isFirst = previous === null;
    return {
      state: {
        lastProfile: profile,
        pluginDepth: isFirst ? 1 : depth + 1,
      },
      preRelease: isFirst,
      switchProfile: profile,
      releaseCount: 0,
    };
  }

  return {
    state: { lastProfile: null, pluginDepth: 0 },
    preRelease: false,
    switchProfile: null,
    releaseCount: Math.max(depth, 1),
  };
}

module.exports = { transitionDeviceState };
