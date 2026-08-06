const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

test("app.js passes Node syntax check", () => {
  execFileSync(process.execPath, ["--check", path.join(__dirname, "..", "app.js")]);
});
