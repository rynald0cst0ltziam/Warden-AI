#!/usr/bin/env node
// Warden CLI entrypoint. Delegates to the compiled CLI so the published
// package works without tsx. In development, run via `npm run warden`.
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "..", "dist", "cli.js");

try {
  const mod = await import(pathToFileURL(cliPath).href);
  // dist/cli.js only auto-runs runCli() when it's the direct entry point.
  // Since we're importing it, we need to call runCli() explicitly.
  if (typeof mod.runCli === "function") {
    mod.runCli().catch((err) => {
      console.error("warden: fatal:", err?.message ?? String(err));
      process.exit(1);
    });
  }
} catch (err) {
  // Compiled output not present — fall back to tsx for dev convenience.
  const { spawn } = await import("node:child_process");
  const src = resolve(here, "..", "src", "cli", "index.ts");
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", src, ...process.argv.slice(2)],
    { stdio: "inherit", shell: false },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
}
