const { test } = require("node:test");
const assert = require("node:assert/strict");
const { removeForgottenDeviceAssignments } = require("../lib/device-settings");

test("keeps assignments for disabled devices still in the device catalog", () => {
  const settings = {
    appMap: [{
      match: "teams",
      assignments: [
        { deviceId: "enabled", profile: "Teams" },
        { deviceId: "disabled", profile: "Profile 1" },
      ],
    }],
  };

  const result = removeForgottenDeviceAssignments(settings, ["enabled", "disabled"]);

  assert.equal(result.removed, 0);
  assert.equal(result.settings, settings);
});

test("removes forgotten-device assignments and orphaned rules", () => {
  const settings = {
    appMap: [
      {
        match: "teams",
        assignments: [
          { deviceId: "kept", profile: "Teams" },
          { deviceId: "forgotten", profile: "Profile 1" },
        ],
      },
      {
        match: "whatsapp",
        assignments: [{ deviceId: "forgotten", profile: "Profile 2" }],
      },
    ],
  };

  const result = removeForgottenDeviceAssignments(settings, ["kept"]);

  assert.equal(result.removed, 2);
  assert.deepEqual(result.settings.appMap, [{
    match: "teams",
    assignments: [{ deviceId: "kept", profile: "Teams" }],
  }]);
});

test("preserves legacy broadcast rules while removing forgotten assignments", () => {
  const settings = {
    appMap: [{
      match: "chrome",
      profile: "Chrome",
      assignments: [{ deviceId: "forgotten", profile: "Profile 3" }],
    }],
  };

  const result = removeForgottenDeviceAssignments(settings, []);

  assert.deepEqual(result.settings.appMap, [{
    match: "chrome",
    profile: "Chrome",
    assignments: [],
  }]);
});
