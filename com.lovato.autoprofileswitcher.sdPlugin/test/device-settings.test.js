const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  getDeviceRules,
  removeForgottenDeviceAssignments,
  replaceDeviceRules,
} = require("../lib/device-settings");

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

test("projects only one device's rules in its own order", () => {
  const appMap = [
    {
      match: "teams",
      assignments: [
        { deviceId: "one", profile: "Teams", order: 1 },
        { deviceId: "two", profile: "Profile 1", order: 0 },
      ],
    },
    {
      match: "chrome",
      assignments: [{ deviceId: "one", profile: "Chrome", order: 0 }],
    },
  ];

  assert.deepEqual(getDeviceRules(appMap, "one"), [
    { match: "chrome", profile: "Chrome" },
    { match: "teams", profile: "Teams" },
  ]);
  assert.deepEqual(getDeviceRules(appMap, "two"), [
    { match: "teams", profile: "Profile 1" },
  ]);
});

test("replaces one device's rules without changing another device", () => {
  const appMap = [{
    match: "teams",
    assignments: [
      { deviceId: "one", profile: "Teams", order: 0 },
      { deviceId: "two", profile: "Profile 1", order: 0 },
    ],
  }];

  const result = replaceDeviceRules(appMap, "one", [
    { match: "chrome", profile: "Chrome" },
  ]);

  assert.deepEqual(getDeviceRules(result, "one"), [
    { match: "chrome", profile: "Chrome" },
  ]);
  assert.deepEqual(getDeviceRules(result, "two"), [
    { match: "teams", profile: "Profile 1" },
  ]);
});

test("merges matching rules while preserving per-device ordering", () => {
  const appMap = [{
    match: "teams",
    assignments: [{ deviceId: "two", profile: "Profile 1", order: 1 }],
  }];

  const result = replaceDeviceRules(appMap, "one", [
    { match: "teams", profile: "Teams" },
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].assignments, [
    { deviceId: "two", profile: "Profile 1", order: 1 },
    { deviceId: "one", profile: "Teams", order: 0 },
  ]);
});
