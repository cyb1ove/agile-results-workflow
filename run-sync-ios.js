#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");

const syncScript = path.join(__dirname, "scripts", "hot-spot-sync.js");
const result = spawnSync(process.execPath, [syncScript], {
  stdio: "inherit",
  cwd: __dirname,
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
