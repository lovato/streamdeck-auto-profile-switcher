const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectProfile,
  findProfileMatch,
  resolveProfileAssignments,
} = require("../lib/detect");

const appMap = [
  { match: "windowsterminal", titleMatch: "PowerShell", profile: "PowerShell" },
  { match: "windowsterminal", profile: "Terminal" },
  { match: "calc", profile: "Calculator" },
];

test("title-specific rule wins over process-only fallback", () => {
  assert.equal(
    detectProfile("windowsterminal", "Windows PowerShell", appMap, {}),
    "PowerShell",
  );
});

test("process-only rule matches when title rule does not", () => {
  assert.equal(
    detectProfile("windowsterminal", "Ubuntu", appMap, {}),
    "Terminal",
  );
});

test("built-in map is used when app-map has no match", () => {
  assert.equal(
    detectProfile("chrome", "", [], { chrome: "Chrome" }),
    "Chrome",
  );
});

test("returns null when nothing matches", () => {
  assert.equal(detectProfile("unknown", "title", appMap, {}), null);
});

test("legacy profile rules broadcast to every connected device", () => {
  const match = findProfileMatch("calc", "", appMap, {});
  assert.deepEqual(
    [...resolveProfileAssignments(match, ["xl", "xlplus"])],
    [["xl", "Calculator"], ["xlplus", "Calculator"]],
  );
});

test("per-device assignments select distinct profiles and release unassigned devices", () => {
  const map = [{
    match: "cubase",
    titleMatch: "Key Editor",
    assignments: [
      { deviceId: "xl", profile: "Key Editor (XL)" },
      { deviceId: "xlplus", profile: "Key Editor (XL+)" },
    ],
  }];
  const match = findProfileMatch("cubase", "Cubase Key Editor", map, {});
  assert.deepEqual(
    [...resolveProfileAssignments(match, ["xl", "xlplus", "other"])],
    [
      ["xl", "Key Editor (XL)"],
      ["xlplus", "Key Editor (XL+)"],
      ["other", null],
    ],
  );
});

test("a per-device assignment overrides a legacy broadcast fallback", () => {
  const map = [{
    match: "cubase",
    profile: "Cubase",
    assignments: [{ deviceId: "xlplus", profile: "Cubase (XL+)" }],
  }];
  const match = findProfileMatch("cubase", "", map, {});
  assert.deepEqual(
    [...resolveProfileAssignments(match, ["xl", "xlplus"])],
    [["xl", "Cubase"], ["xlplus", "Cubase (XL+)"]],
  );
});

test("built-in profile matches broadcast to every connected device", () => {
  const match = findProfileMatch("chrome", "", [], { chrome: "Chrome" });
  assert.deepEqual(
    [...resolveProfileAssignments(match, ["xl", "xlplus"])],
    [["xl", "Chrome"], ["xlplus", "Chrome"]],
  );
});

test("no match releases every connected device independently", () => {
  assert.deepEqual(
    [...resolveProfileAssignments(null, ["xl", "xlplus"])],
    [["xl", null], ["xlplus", null]],
  );
});
