const { test } = require("node:test");
const assert = require("node:assert/strict");
const { transitionDeviceState } = require("../lib/device-state");

test("first managed switch pre-releases only that device", () => {
  assert.deepEqual(
    transitionDeviceState({ lastProfile: null, pluginDepth: 0 }, "Key Editor (XL)"),
    {
      state: { lastProfile: "Key Editor (XL)", pluginDepth: 1 },
      preRelease: true,
      switchProfile: "Key Editor (XL)",
      releaseCount: 0,
    },
  );
});

test("managed-to-managed transition increments the device stack", () => {
  assert.deepEqual(
    transitionDeviceState({ lastProfile: "Cubase", pluginDepth: 2 }, "Key Editor"),
    {
      state: { lastProfile: "Key Editor", pluginDepth: 3 },
      preRelease: false,
      switchProfile: "Key Editor",
      releaseCount: 0,
    },
  );
});

test("release peels each level of one device's stack", () => {
  assert.deepEqual(
    transitionDeviceState({ lastProfile: "Key Editor", pluginDepth: 3 }, null),
    {
      state: { lastProfile: null, pluginDepth: 0 },
      preRelease: false,
      switchProfile: null,
      releaseCount: 3,
    },
  );
});

test("unchanged profile does not create a transition", () => {
  assert.equal(
    transitionDeviceState({ lastProfile: "Cubase", pluginDepth: 1 }, "Cubase"),
    null,
  );
});
