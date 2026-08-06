const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detectProfile } = require("../lib/detect");

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
