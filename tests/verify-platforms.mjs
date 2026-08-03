import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execSync } from "node:child_process";

const testDir = join(tmpdir(), "warden-platform-verify-" + Date.now());
mkdirSync(testDir, { recursive: true });

// Create fake agent config dirs/files so init has something to write to
const agentConfigs = [
  { path: join(testDir, ".mcp.json"), content: "{}" },
  { path: join(testDir, ".cursor", "mcp.json"), content: "{}" },
  { path: join(testDir, ".vscode", "mcp.json"), content: "{}" },
  { path: join(testDir, ".devin", "config.json"), content: "{}" },
];

for (const c of agentConfigs) {
  mkdirSync(join(c.path, ".."), { recursive: true });
  writeFileSync(c.path, c.content);
}

// Run warden init in the test dir
process.chdir(testDir);
try {
  execSync("node C:/Users/Hubby/Desktop/warden/dist/cli.js init", { stdio: "pipe" });
} catch (e) {
  // init may exit non-zero but still write configs
}

// Now verify every config file
const results = [];
function checkConfig(filePath, format, label) {
  if (!existsSync(filePath)) {
    results.push({ label, path: filePath, status: "MISSING", format });
    return;
  }
  const content = readFileSync(filePath, "utf8");
  if (format === "json") {
    try {
      const parsed = JSON.parse(content);
      const hasWarden = parsed.mcpServers?.warden || parsed.mcp_servers?.warden;
      const hasCommand = parsed.mcpServers?.warden?.command || parsed.mcp_servers?.warden?.command;
      results.push({
        label,
        path: filePath,
        status: hasWarden && hasCommand ? "VALID" : "INVALID",
        format: "json",
        hasWarden: !!hasWarden,
        hasCommand: !!hasCommand,
      });
    } catch (e) {
      results.push({ label, path: filePath, status: "INVALID JSON", format: "json", error: e.message });
    }
  } else if (format === "toml") {
    const hasWarden = content.includes("[mcp_servers.warden]");
    const hasCommand = content.includes("command");
    results.push({
      label,
      path: filePath,
      status: hasWarden && hasCommand ? "VALID" : "INVALID",
      format: "toml",
      hasWarden,
      hasCommand,
    });
  }
}

const home = homedir();

// Check all configs
checkConfig(join(testDir, ".mcp.json"), "json", "Claude Code (project)");
checkConfig(join(testDir, ".cursor", "mcp.json"), "json", "Cursor (project)");
checkConfig(join(testDir, ".vscode", "mcp.json"), "json", "VS Code Copilot (project)");
checkConfig(join(testDir, ".devin", "config.json"), "json", "Devin (project)");
checkConfig(join(home, ".cursor", "mcp.json"), "json", "Cursor (global)");
checkConfig(join(home, ".codeium", "windsurf", "mcp_config.json"), "json", "Windsurf/Devin");
checkConfig(join(home, ".codex", "config.toml"), "toml", "Codex (TOML)");
checkConfig(join(home, ".continue", "config.json"), "json", "Continue");
checkConfig(join(home, ".gemini", "settings.json"), "json", "Gemini CLI");
checkConfig(join(home, ".gemini", "antigravity", "mcp_config.json"), "json", "Antigravity (v1)");
checkConfig(join(home, ".gemini", "config", "mcp_config.json"), "json", "Antigravity (v2 shared)");
checkConfig(join(home, ".aws", "amazonq", "mcp.json"), "json", "Amazon Q");

// Print results
console.log("\n=== Platform Config Verification ===\n");
let valid = 0, invalid = 0, missing = 0;
for (const r of results) {
  const icon = r.status === "VALID" ? "OK  " : r.status === "MISSING" ? "MISS" : "FAIL";
  console.log(`  [${icon}] ${r.format.toUpperCase().padEnd(4)} ${r.label.padEnd(25)} ${r.path.replace(testDir, "<testdir>").replace(home, "~")}`);
  if (r.hasWarden !== undefined) console.log(`         warden: ${r.hasWarden}, command: ${r.hasCommand}`);
  if (r.error) console.log(`         error: ${r.error}`);
  if (r.status === "VALID") valid++;
  else if (r.status === "MISSING") missing++;
  else invalid++;
}
console.log(`\n  Total: ${results.length} | Valid: ${valid} | Invalid: ${invalid} | Missing: ${missing}`);

// Cleanup test dir
rmSync(testDir, { recursive: true });
