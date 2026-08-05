#!/usr/bin/env node
/**
 * Postinstall hook — runs `warden init` automatically after npm install.
 * This makes Warden truly plug-and-play: install once, everything is set up.
 *
 * If anything fails, we print a helpful message and exit silently.
 * We never crash the install — npm install should always succeed.
 */
const { existsSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { execSync } = require("node:child_process");

const pkgRoot = join(dirname(__dirname));
const cliJs = join(pkgRoot, "dist", "cli.js");

// If dist/ doesn't exist (e.g., cloning the repo for development), skip.
// The user will run `npm run build` then `warden init` manually.
if (!existsSync(cliJs)) {
  process.exit(0);
}

try {
  // Run `warden init` silently — it registers MCP server in all detected
  // agents, writes rules files, builds code index, compresses memory files.
  // We suppress output to keep the install clean, but exit codes propagate.
  execSync(`node "${cliJs}" init --skip-index`, {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 30000,
    cwd: process.cwd(),
  });
} catch {
  // Silently fail — the user can run `warden init` manually.
  // We never want to break `npm install -g warden`.
}

process.exit(0);
